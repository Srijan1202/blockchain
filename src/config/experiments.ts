import type { Address, Hex } from "viem";
import type { Environment, RunPath, TxKind } from "../core/types.js";
import type { ExperimentType } from "../storage/db.js";

/**
 * Experiment campaign definitions (BLUEPRINT section 8).
 *
 * Everything here is FIXED per campaign: sender, transaction kind, value, gas
 * limit, chain and RPC endpoint. Nothing is randomised in the pilot - variance
 * has to be understood before anything is deliberately varied, or a wide
 * distribution cannot be attributed to any particular cause.
 *
 * The transaction values below are campaign constants, not protocol
 * parameters. They are chosen here, not read from chain, and that is the
 * distinction I1 draws: a protocol parameter must be read and recorded, an
 * experimental setting must be declared and held constant.
 */

export interface ExperimentDef {
  type: ExperimentType;
  name: string;
  /** Which path this campaign exercises. */
  path: RunPath;
  environment: Environment;
  txKind: TxKind;
  /** Value carried by each transaction, in wei. Small and fixed. */
  valueWei: bigint;
  /** Gas limit for the L2 execution. Fixed so cost comparisons are like-for-like. */
  gasLimit: bigint;
  /** Calldata. Empty for a plain transfer. */
  data: Hex;
  /**
   * Destination. `null` means "the sender's own address" - a self-transfer,
   * so a campaign does not burn funds it will need for later runs.
   */
  to: Address | null;
  /** Chains this campaign may run against. */
  chains: readonly string[];
  notes: string;
}

/** 0.000001 ETH. Large enough to be a real transfer, small enough to repeat. */
const CAMPAIGN_VALUE_WEI = 1_000_000_000_000n;
const CAMPAIGN_GAS_LIMIT = 100_000n;

export const EXPERIMENTS: Record<string, ExperimentDef> = {
  A: {
    type: "A",
    name: "Normal inclusion baseline",
    path: "normal",
    environment: "testnet",
    txKind: "eth_transfer",
    valueWei: CAMPAIGN_VALUE_WEI,
    gasLimit: CAMPAIGN_GAS_LIMIT,
    data: "0x",
    to: null,
    chains: ["arb-sepolia", "op-sepolia", "base-sepolia"],
    notes: "Baseline via the sequencer RPC. Supplies M-L4 and the denominator of M-C4.",
  },
  B: {
    type: "B",
    name: "Forced path, healthy sequencer",
    path: "forced",
    environment: "testnet",
    txKind: "eth_transfer",
    valueWei: CAMPAIGN_VALUE_WEI,
    gasLimit: CAMPAIGN_GAS_LIMIT,
    data: "0x",
    to: null,
    chains: ["arb-sepolia", "op-sepolia", "base-sepolia"],
    notes:
      "Submit via the L1 mechanism. On Arbitrum this measures the AUTO-INCLUSION leg only: " +
      "per BLUEPRINT 20.1 the force leg is unreachable on a healthy public testnet. Never " +
      "describe an E2 result as censorship recovery (I4).",
  },
  C: {
    type: "C",
    name: "True censorship and recovery",
    path: "forced",
    environment: "devnet",
    txKind: "eth_transfer",
    valueWei: CAMPAIGN_VALUE_WEI,
    gasLimit: CAMPAIGN_GAS_LIMIT,
    data: "0x",
    to: null,
    chains: [],
    notes:
      "Arbitrum only, E1 devnet only - the sole environment where the sequencer can be made " +
      "to genuinely refuse. `chains` is empty until a devnet is registered; it must never be " +
      "pointed at a public testnet.",
  },
  C_prime: {
    type: "C_prime",
    name: "Sequencer unavailable",
    path: "forced",
    environment: "devnet",
    txKind: "eth_transfer",
    valueWei: CAMPAIGN_VALUE_WEI,
    gasLimit: CAMPAIGN_GAS_LIMIT,
    data: "0x",
    to: null,
    chains: [],
    notes:
      "OP Stack on a local devnet: does the deposit land while the sequencer is down? " +
      "Deliberately not a censorship test - derivation forces the deposit regardless.",
  },
};

/**
 * D and E are absent on purpose. D is a re-analysis of B's data bucketed by the
 * L1 base fee at submission, so it costs zero extra transactions. E is mainnet
 * observation and belongs to the indexer, not the runner.
 */
export const NON_CAMPAIGN_EXPERIMENTS = ["D", "E"] as const;

export function experimentDef(id: string): ExperimentDef {
  const def = EXPERIMENTS[id];
  if (!def) {
    const known = Object.keys(EXPERIMENTS).join(", ");
    if ((NON_CAMPAIGN_EXPERIMENTS as readonly string[]).includes(id)) {
      throw new Error(
        `Experiment ${id} is not a submission campaign: D is a re-analysis of B's data and E is mainnet indexing.`,
      );
    }
    throw new Error(`Unknown experiment ${id}. Known campaigns: ${known}`);
  }
  return def;
}

/**
 * Deterministic campaign id.
 *
 * Stable across invocations on purpose: re-running the same campaign must
 * produce the same idempotency keys so it resumes rather than double-submits.
 */
export function campaignId(experimentId: string, chainKey: string, suffix?: string): string {
  return suffix ? `${experimentId}-${chainKey}-${suffix}` : `${experimentId}-${chainKey}`;
}
