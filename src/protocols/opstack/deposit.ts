import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  toRlp,
  trim,
  type Address,
  type Hex,
  type Log,
} from "viem";

/**
 * Deposit mechanics for the OP Stack forced path.
 *
 * ADDRESS ALIASING - read this before asking. A deposit from a CONTRACT sender
 * has the alias 0x1111000000000000000000000000000000001111 added to its
 * address on L2; a deposit from an EOA does NOT. The experiment wallet is an
 * EOA, so aliasing does not apply anywhere in this study and `from` on L2
 * equals the L1 sender unchanged. This is written down because a reviewer will
 * ask and because the code otherwise looks like it forgot.
 */
export const L1_TO_L2_ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;

/** Applies the aliasing rule. Present for completeness; unused for EOA senders. */
export function applyL1ToL2Alias(address: Address): Address {
  const aliased = (BigInt(address) + L1_TO_L2_ALIAS_OFFSET) % (1n << 160n);
  return pad(toHex(aliased), { size: 20 }) as Address;
}

/**
 * Deposit source-hash domain. 0 = a user deposit, which is all this study
 * produces. Other domains (L1 attributes, upgrades) are system-generated.
 */
const DEPOSIT_SOURCE_DOMAIN_USER = 0n;

/**
 * Derive the L2 deposit transaction hash from the L1 TransactionDeposited log.
 *
 * The derivation, per the OP Stack deposit spec:
 *   depositID  = keccak256(abi.encode(l1BlockHash, uint256(logIndex)))
 *   sourceHash = keccak256(abi.encode(bytes32(domain), depositID))
 *   tx         = 0x7E || rlp([sourceHash, from, to, mint, value, gas,
 *                             isSystemTx, data])
 *   hash       = keccak256(tx)
 *
 * `logIndex` is the index of the log WITHIN THE L1 BLOCK, not within the
 * receipt - using the receipt-local index yields a plausible but wrong hash.
 *
 * VALIDATED 2026-09-07 against 5 historical deposits on OP Sepolia: every
 * derived hash resolved to a real type-0x7e transaction on L2 (see
 * check-deposit-derivation). Those were third-party deposits read read-only.
 * Confirm once more against the first deposit this harness itself sends (Day 4)
 * before trusting any S7/S8 timestamp that depends on it.
 */
export function depositSourceHash(l1BlockHash: Hex, logIndex: bigint): Hex {
  const depositId = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [l1BlockHash, logIndex]),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [pad(toHex(DEPOSIT_SOURCE_DOMAIN_USER), { size: 32 }), depositId],
    ),
  );
}

/** The fields carried in TransactionDeposited.opaqueData. */
export interface OpaqueDepositData {
  mint: bigint;
  value: bigint;
  gasLimit: bigint;
  isCreation: boolean;
  data: Hex;
}

/**
 * Decode opaqueData: mint (32) || value (32) || gasLimit (8) || isCreation (1)
 * || data (rest). Packed, not ABI-encoded, so it is sliced by hand.
 */
export function decodeOpaqueData(opaqueData: Hex): OpaqueDepositData {
  const body = opaqueData.slice(2);
  const MIN_HEX = (32 + 32 + 8 + 1) * 2;
  if (body.length < MIN_HEX) {
    throw new Error(`opaqueData too short: ${body.length / 2} bytes, need at least ${MIN_HEX / 2}`);
  }
  const at = (start: number, lenBytes: number) => body.slice(start, start + lenBytes * 2);
  return {
    mint: BigInt("0x" + at(0, 32)),
    value: BigInt("0x" + at(64, 32)),
    gasLimit: BigInt("0x" + at(128, 8)),
    isCreation: at(144, 1) !== "00",
    data: ("0x" + body.slice(146)) as Hex,
  };
}

/** RLP fields must be minimally encoded: zero is empty, not 0x00. */
function rlpQuantity(value: bigint): Hex {
  return value === 0n ? "0x" : (trim(toHex(value)) as Hex);
}

/**
 * Compute the L2 transaction hash of the deposit produced by an L1
 * TransactionDeposited log.
 */
export function deriveDepositTxHash(args: {
  l1BlockHash: Hex;
  logIndex: bigint;
  from: Address;
  to: Address;
  opaque: OpaqueDepositData;
}): Hex {
  const sourceHash = depositSourceHash(args.l1BlockHash, args.logIndex);
  const encoded = toRlp([
    sourceHash,
    args.from,
    // A creation deposit has an empty `to`.
    args.opaque.isCreation ? "0x" : args.to,
    rlpQuantity(args.opaque.mint),
    rlpQuantity(args.opaque.value),
    rlpQuantity(args.opaque.gasLimit),
    // isSystemTransaction is false for every user deposit.
    "0x",
    args.opaque.data,
  ]);
  return keccak256(concatHex(["0x7e", encoded]));
}

/** Pull the pieces needed for derivation out of a decoded TransactionDeposited log. */
export function depositFromLog(log: {
  blockHash: Hex | null;
  logIndex: number | null;
  args: { from: Address; to: Address; opaqueData: Hex };
}): { sourceHash: Hex; l2TxHash: Hex; opaque: OpaqueDepositData } {
  if (log.blockHash === null || log.logIndex === null) {
    throw new Error("TransactionDeposited log is still pending: no blockHash/logIndex to derive from");
  }
  const opaque = decodeOpaqueData(log.args.opaqueData);
  return {
    sourceHash: depositSourceHash(log.blockHash, BigInt(log.logIndex)),
    l2TxHash: deriveDepositTxHash({
      l1BlockHash: log.blockHash,
      logIndex: BigInt(log.logIndex),
      from: log.args.from,
      to: log.args.to,
      opaque,
    }),
    opaque,
  };
}

export type TransactionDepositedLog = Log;
