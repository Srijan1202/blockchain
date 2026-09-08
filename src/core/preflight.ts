import { encodeFunctionData, formatEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ETH_SEPOLIA, type L2Config } from "../config/chains.js";
import { INBOX_ABI } from "../protocols/arbitrum/abi.js";
import { OPTIMISM_PORTAL_DEPOSIT_ABI } from "../protocols/opstack/abi.js";
import type { RunPath, TxSpec } from "./types.js";

/**
 * Balance preflight.
 *
 * THE FUNDING MODEL, traced from the adapters rather than assumed:
 *
 *   A on op-sepolia   OP Sepolia only. submitNormal sends through
 *                     rpcFor(cfg.rpcEnv); there is no L1 transaction on the
 *                     normal path at all.
 *   A on arb-sepolia  Arbitrum Sepolia only. Same code path.
 *   B on op-sepolia   Ethereum Sepolia only, gas PLUS msg.value, because
 *                     buildDepositCall sets value: tx.valueWei. The deposit
 *                     executes on L2 as a type-0x7E transaction whose L2 gas
 *                     was already bought by burning L1 gas, and its value is
 *                     minted from that msg.value - so no OP Sepolia balance is
 *                     needed.
 *   B on arb-sepolia  BOTH. Ethereum Sepolia for sendL2Message gas (the L1 call
 *                     carries no value), and Arbitrum Sepolia because the
 *                     signed L2 transaction inside the delayed message executes
 *                     on L2 and pays value + gas from the SENDER'S L2 BALANCE.
 *   base-sepolia      Nothing. The adapter refuses to construct while its bound
 *                     is UNVERIFIED.
 *
 * The arb-sepolia forced case is the one that matters and the one that is easy
 * to get backwards. With an empty Arbitrum Sepolia balance the message queues
 * fine, reaches S4, and then FAILS ON EXECUTION - which is indistinguishable at
 * a glance from the sequencer declining to include it. That would look like
 * exactly the censorship signal this study exists to measure, produced entirely
 * by an unfunded wallet.
 */

/**
 * Explicit safety margin over the derived minimum, in basis points.
 *
 * This is a MARGIN, not an estimate of anything: fees move between the
 * preflight and the send, and a campaign that dies halfway leaves a partial
 * sample. It is applied visibly and reported separately so nobody mistakes it
 * for a measured requirement.
 */
export const PREFLIGHT_MARGIN_BPS = 2000n; // 20%

/**
 * Fallback L1 gas figures, used ONLY when eth_estimateGas cannot be reached -
 * which is typically because the balance is already too low to simulate, i.e.
 * exactly the case being detected.
 *
 * These are operational estimates for a safety bound, NOT protocol parameters:
 * they never enter the dataset, are never reported, and no measurement depends
 * on them. Anywhere one is used, gasBasis says so in the output.
 */
const NOMINAL_L1_GAS_DEPOSIT = 150_000n;
const NOMINAL_L1_GAS_SEND_L2_MESSAGE = 120_000n;

/** A throwaway key used only to size calldata. Never funded, never sent from. */
const SIZING_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export interface BalanceRequirement {
  network: string;
  chainKey: string;
  rpcEnv: string;
  address: Address;
  /** What the funds are actually for, in the user's terms. */
  purpose: string;
  /** Derived minimum for a SINGLE submission, before the margin. */
  perRunBaseWei: bigint;
  /** How many submissions this campaign will actually make. */
  runs: number;
  /** perRunBaseWei x runs. The campaign total before the margin. */
  baseRequiredWei: bigint;
  marginBps: bigint;
  /** baseRequired plus the margin. This is what is enforced. */
  requiredWei: bigint;
  actualWei: bigint;
  sufficient: boolean;
  /** How the gas component was obtained, so the number can be audited. */
  gasBasis: string;
}

function withMargin(base: bigint): bigint {
  return base + (base * PREFLIGHT_MARGIN_BPS) / 10_000n;
}

async function maxFeePerGas(client: PublicClient): Promise<{ fee: bigint; basis: string }> {
  const fees = await client.estimateFeesPerGas();
  if (fees.maxFeePerGas !== undefined && fees.maxFeePerGas !== null) {
    return { fee: fees.maxFeePerGas, basis: "live estimateFeesPerGas" };
  }
  const gasPrice = await client.getGasPrice();
  return { fee: gasPrice, basis: "live getGasPrice" };
}

/** Try to estimate real gas; fall back to a labelled nominal if the node refuses. */
async function estimateL1Gas(
  l1: PublicClient,
  account: Address,
  call: { to: Address; data: Hex; value: bigint },
  nominal: bigint,
  label: string,
): Promise<{ gas: bigint; basis: string }> {
  try {
    const gas = await l1.estimateGas({ account, to: call.to, data: call.data, value: call.value });
    return { gas, basis: "live eth_estimateGas" };
  } catch (e) {
    const firstLine = String(e).split("\n")[0] ?? String(e);
    return {
      gas: nominal,
      basis: `NOMINAL ${label} fallback (${nominal} gas) - eth_estimateGas unavailable: ${firstLine.slice(0, 80)}`,
    };
  }
}

/**
 * Representative sendL2Message calldata, for sizing only.
 *
 * The real payload wraps a signed L2 transaction, and signing the real one here
 * would consume a campaign nonce. A throwaway key signs an identically shaped
 * transaction instead, so the calldata length and byte entropy match what will
 * actually be sent. Nothing is submitted.
 */
async function representativeSendL2MessageCalldata(tx: TxSpec, chainId: number): Promise<Hex> {
  const sizing = privateKeyToAccount(SIZING_KEY);
  const signed = await sizing.signTransaction({
    type: "eip1559",
    chainId,
    nonce: 0,
    to: tx.to,
    value: tx.valueWei,
    data: tx.data,
    gas: tx.gasLimit,
    maxFeePerGas: 100_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  const messageData = (`0x04${signed.slice(2)}`) as Hex;
  return encodeFunctionData({ abi: INBOX_ABI, functionName: "sendL2Message", args: [messageData] });
}

export interface PreflightInput {
  path: RunPath;
  cfg: L2Config;
  tx: TxSpec;
  sender: Address;
  l1: PublicClient;
  l2: PublicClient;
  /**
   * How many submissions this invocation will actually make.
   *
   * A campaign submits n transactions, so checking for one is not a preflight -
   * it lets --n 25 start with funds for a single run and die mid-campaign,
   * leaving a partial sample that has to be discarded. This is n MINUS the
   * indices already claimed via hasAlreadySubmitted, so a resumed campaign does
   * not demand funds for work that is already done.
   */
  runs: number;
  /** Portal address, for the OP forced path. */
  portal?: Address;
  /** Delayed inbox address, for the Arbitrum forced path. */
  inbox?: Address;
}

/** Build a requirement, scaling the per-run minimum to the whole campaign. */
function requirement(args: {
  network: string;
  rpcEnv: string;
  address: Address;
  purpose: string;
  perRunBaseWei: bigint;
  runs: number;
  actualWei: bigint;
  gasBasis: string;
}): BalanceRequirement {
  const base = args.perRunBaseWei * BigInt(args.runs);
  const required = withMargin(base);
  return {
    network: args.network,
    chainKey: args.network,
    rpcEnv: args.rpcEnv,
    address: args.address,
    purpose: args.purpose,
    perRunBaseWei: args.perRunBaseWei,
    runs: args.runs,
    baseRequiredWei: base,
    marginBps: PREFLIGHT_MARGIN_BPS,
    requiredWei: required,
    actualWei: args.actualWei,
    sufficient: args.actualWei >= required,
    gasBasis: args.gasBasis,
  };
}

/**
 * Compute what this campaign needs, on which network, and whether it is there.
 *
 * Everything is derived from the campaign's own gasLimit and valueWei plus live
 * fee data. Nothing here is a hardcoded requirement.
 */
export async function preflightBalances(input: PreflightInput): Promise<BalanceRequirement[]> {
  const { path, cfg, tx, sender, l1, l2, runs } = input;
  if (!Number.isInteger(runs) || runs < 0) throw new Error(`preflight: runs must be a non-negative integer, got ${runs}`);
  const out: BalanceRequirement[] = [];

  const l2Balance = async () => l2.getBalance({ address: sender });
  const l1Balance = async () => l1.getBalance({ address: sender });

  if (path === "normal") {
    // Normal path: one L2 transaction, nothing on L1.
    const { fee, basis } = await maxFeePerGas(l2);
    out.push(requirement({
      network: cfg.key,
      rpcEnv: cfg.rpcEnv,
      address: sender,
      purpose: "L2 transaction via the sequencer RPC: value + gas. No L1 transaction exists on the normal path.",
      perRunBaseWei: tx.valueWei + tx.gasLimit * fee,
      runs,
      actualWei: await l2Balance(),
      gasBasis: `${tx.gasLimit} gas x maxFeePerGas (${basis})`,
    }));
    return out;
  }

  // Forced path.
  const l1Fee = await maxFeePerGas(l1);

  if (cfg.family === "op-stack") {
    const portal = input.portal;
    if (!portal) throw new Error("preflight: portal address required for the OP Stack forced path");
    const data = encodeFunctionData({
      abi: OPTIMISM_PORTAL_DEPOSIT_ABI,
      functionName: "depositTransaction",
      args: [tx.to, tx.valueWei, tx.gasLimit, false, tx.data],
    });
    const { gas, basis } = await estimateL1Gas(
      l1, sender, { to: portal, data, value: tx.valueWei }, NOMINAL_L1_GAS_DEPOSIT, "depositTransaction",
    );
    out.push(requirement({
      network: ETH_SEPOLIA.key,
      rpcEnv: ETH_SEPOLIA.rpcEnv,
      address: sender,
      purpose:
        "L1 OptimismPortal.depositTransaction: gas + msg.value. The msg.value is minted on L2 and the " +
        "deposit's L2 gas is prepaid by burning L1 gas, so NO OP Sepolia balance is required.",
      perRunBaseWei: tx.valueWei + gas * l1Fee.fee,
      runs,
      actualWei: await l1Balance(),
      gasBasis: `${gas} gas x maxFeePerGas (${basis}; fee ${l1Fee.basis}) + msg.value ${tx.valueWei}`,
    }));
    return out;
  }

  if (cfg.family === "arbitrum-nitro") {
    const inbox = input.inbox;
    if (!inbox) throw new Error("preflight: inbox address required for the Arbitrum forced path");

    // Leg 1 - L1: sendL2Message gas only. The L1 call carries NO value.
    const data = await representativeSendL2MessageCalldata(tx, cfg.chainId);
    const { gas, basis } = await estimateL1Gas(
      l1, sender, { to: inbox, data, value: 0n }, NOMINAL_L1_GAS_SEND_L2_MESSAGE, "sendL2Message",
    );
    out.push(requirement({
      network: ETH_SEPOLIA.key,
      rpcEnv: ETH_SEPOLIA.rpcEnv,
      address: sender,
      purpose: "L1 Inbox.sendL2Message: gas only. The L1 call carries no value.",
      perRunBaseWei: gas * l1Fee.fee,
      runs,
      actualWei: await l1Balance(),
      gasBasis: `${gas} gas x maxFeePerGas (${basis}; fee ${l1Fee.basis})`,
    }));

    // Leg 2 - L2: the signed transaction inside the delayed message executes on
    // Arbitrum and pays from the sender's L2 balance. This is the leg that is
    // easy to forget and that fails as a false censorship signal.
    const l2Fee = await maxFeePerGas(l2);
    out.push(requirement({
      network: cfg.key,
      rpcEnv: cfg.rpcEnv,
      address: sender,
      purpose:
        "L2 execution of the delayed message: value + gas, paid from the Arbitrum Sepolia balance. " +
        "Without it the message queues, reaches S4, then fails on execution - which looks like sequencer non-inclusion.",
      perRunBaseWei: tx.valueWei + tx.gasLimit * l2Fee.fee,
      runs,
      actualWei: await l2Balance(),
      gasBasis: `${tx.gasLimit} gas x maxFeePerGas (${l2Fee.basis}) + value ${tx.valueWei}`,
    }));
    return out;
  }

  throw new Error(`preflight: no funding model for family ${cfg.family}`);
}

export function formatRequirement(r: BalanceRequirement): string {
  const short = r.requiredWei - r.actualWei;
  return [
    `  ${r.sufficient ? "OK  " : "SHORT"}  ${r.network}  (${r.rpcEnv})`,
    `         address   ${r.address}`,
    `         purpose   ${r.purpose}`,
    `         have      ${formatEther(r.actualWei)} ETH  (${r.actualWei} wei)`,
    `         need      ${formatEther(r.requiredWei)} ETH  (${r.requiredWei} wei)  <- campaign total, enforced`,
    `         per run   ${formatEther(r.perRunBaseWei)} ETH  x ${r.runs} run(s) = ${formatEther(r.baseRequiredWei)} ETH derived`,
    `         margin    +${Number(r.marginBps) / 100}% on the derived total`,
    `         basis     ${r.gasBasis}`,
    r.sufficient ? "" : `         SHORTFALL ${formatEther(short)} ETH  (${short} wei)`,
  ].filter(Boolean).join("\n");
}

export class InsufficientBalance extends Error {
  readonly requirements: BalanceRequirement[];
  constructor(requirements: BalanceRequirement[]) {
    const short = requirements.filter((r) => !r.sufficient);
    super(
      `Insufficient balance on ${short.length} network(s) - refusing to submit.\n\n` +
        requirements.map(formatRequirement).join("\n\n") +
        `\n\nFund the SHORT network(s) above and re-run. Nothing was submitted.`,
    );
    this.name = "InsufficientBalance";
    this.requirements = requirements;
  }
}

/** Throws InsufficientBalance if any requirement is short. */
export function assertSufficient(requirements: BalanceRequirement[]): void {
  if (requirements.some((r) => !r.sufficient)) throw new InsufficientBalance(requirements);
}
