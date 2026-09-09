import type { Address, Hex } from "viem";

/**
 * Domain types (T5).
 *
 * Numeric discipline (CLAUDE.md I8): every chain-derived quantity - wei, gas,
 * block numbers, block timestamps - is `bigint` in memory and becomes `string`
 * only at the storage boundary in storage/db.ts. Nothing here is `number`
 * except values that are genuinely small and non-monetary: a nonce, a byte
 * count, a retry count.
 *
 * These are the canonical unions. storage/db.ts imports them rather than
 * redeclaring them, so a stage or clock source cannot drift between the domain
 * model and the schema.
 */

/** BLUEPRINT section 14 stage model. Not every protocol produces every stage. */
export type LifecycleStage = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9";

/** The three clocks of BLUEPRINT section 11. Never mixed silently. */
export type ClockSource = "wall" | "l1_block" | "l2_block";

/** Whether a stage was directly observed or computed from other values. */
export type Confidence = "observed" | "inferred";

export type ChainLayer = "L1" | "L2";

/** The three environments of BLUEPRINT section 2: E1 devnet, E2 testnet, E3 mainnet. */
export type Environment = "devnet" | "testnet" | "mainnet";
export type RunPath = "normal" | "forced";
export type TxKind = "eth_transfer" | "contract_call";
export type Outcome = "pending" | "success" | "failed" | "timeout";

/** The transaction a run is trying to get included. */
export interface TxSpec {
  to: Address;
  /** Value in wei. */
  valueWei: bigint;
  /** Calldata; "0x" for a plain transfer. */
  data: Hex;
  /** Gas limit for the L2 execution. */
  gasLimit: bigint;
  kind: TxKind;
}

/**
 * What a submission returns. Both hashes can be present on the forced path:
 * l1TxHash is the enqueue, l1ForceHash the Arbitrum forceInclude leg. On OP
 * Stack l1ForceHash is always null, which is the M-U1 measurement, not a gap.
 */
export interface SubmissionRef {
  runId: string;
  chainKey: string;
  path: RunPath;
  l1TxHash: Hex | null;
  l1ForceHash: Hex | null;
  l2TxHash: Hex | null;
  /**
   * Local wall clock when the transaction was CONSTRUCTED/SIGNED, ISO8601.
   * This is stage S1. It is distinct from submittedAt (S2, handed to the path)
   * even where the two are milliseconds apart, and M-L4 is measured from it.
   */
  generatedAt: string;
  /** Local wall clock at submission, ISO8601. This is stage S2. */
  submittedAt: string;
}

/** One observable stage of a run's lifecycle, with its provenance. */
export interface LifecycleEvent {
  eventId: string;
  runId: string;
  stage: LifecycleStage;
  chainLayer: ChainLayer;
  blockNumber: bigint | null;
  /** Chain clock, seconds. */
  blockTimestamp: bigint | null;
  /** Local wall clock when we saw it, ISO8601. */
  observedAt: string | null;
  clockSource: ClockSource;
  confidence: Confidence;
  finalized: boolean;
  /** Event signature / log index, so a row can be traced back to chain data. */
  rawRef: string | null;
  /**
   * Hashes that only became knowable DURING tracking, for the tracker to
   * persist onto the run.
   *
   * The forced OP path cannot know its L2 deposit hash at submission time: the
   * hash derives from the L1 block hash and log index, which do not exist until
   * the receipt lands. Surfacing it here as structured data - rather than
   * leaving it to be scraped back out of rawRef - is what stops runs.l2_tx_hash
   * staying null and collectCosts skipping the whole L2 leg.
   *
   * Not a column: toLifecycleEventRow ignores it.
   */
  discovered?: { l2TxHash?: Hex; l1ForceHash?: Hex };
}

/** One submitted transaction. */
export interface RunRecord {
  runId: string;
  experimentId: string;
  /** Guards I5: a retry must never double-submit an L1 transaction. */
  idempotencyKey: string;
  path: RunPath;
  txKind: TxKind;
  sender: Address;
  nonce: number | null;
  gasLimit: bigint | null;
  calldataBytes: number;
  l1TxHash: Hex | null;
  l1ForceHash: Hex | null;
  l2TxHash: Hex | null;
  outcome: Outcome;
  retryCount: number;
  /** A revert reason belongs here as data, never thrown away (I6). */
  error: string | null;
  submittedAt: string;
}

/** Costs for one run. Every field is a uint256 quantity. */
export interface CostRecord {
  runId: string;
  l1GasUsed: bigint | null;
  l1GasPrice: bigint | null;
  l1FeeWei: bigint | null;
  /** Arbitrum forceInclude leg only; structurally absent on OP Stack (M-C2). */
  forceGasUsed: bigint | null;
  forceFeeWei: bigint | null;
  l2GasUsed: bigint | null;
  l2FeeWei: bigint | null;
  totalFeeWei: bigint | null;
  /** For the congestion analysis (H3 / experiment D). */
  l1BaseFeeAtSubmit: bigint | null;

  /**
   * OP Stack ONLY. The L1 data fee, in wei, priced at the L1 gas price and
   * charged on top of L2 execution. This is a FEE.
   *
   * Not interchangeable with arbL1GasAllocation below - see migration 003.
   */
  opL1DataFeeWei: bigint | null;
  /** OP Stack only. L1 gas units used to post this transaction's data. */
  opL1GasUsed: bigint | null;
  /** OP Stack only. The L1 gas price used to price the data fee. */
  opL1GasPrice: bigint | null;

  /**
   * Arbitrum ONLY. gasUsedForL1: an L2 GAS ALLOCATION, already included inside
   * l2GasUsed and priced at the L2 gas price. Nitro's way of recouping the
   * posting cost - NOT a measurement of what the L1 posting cost.
   *
   * Never sum or compare this with opL1DataFeeWei; they are different
   * quantities in different units. See migration 003.
   */
  arbL1GasAllocation: bigint | null;
}
