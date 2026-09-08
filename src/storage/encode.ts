import type {
  CostRecord,
  LifecycleEvent,
  RunRecord,
} from "../core/types.js";
import type { CostRow, LifecycleEventRow, RunRow } from "./db.js";

/**
 * THE bigint/string boundary. There is exactly one, and it is this file.
 *
 * Adapters work in bigint; SQLite stores uint256 as TEXT (I8). Every crossing
 * happens through u256() here. That is enforced by the type system rather than
 * by discipline: the uint256 columns are typed U256String, a branded string
 * that only u256() can produce, so
 *
 *   l1_fee_wei: someWei.toString()      // does not compile
 *   l1_fee_wei: String(Number(wei))     // does not compile
 *   l1_fee_wei: "12345"                 // does not compile
 *   l1_fee_wei: u256(someWei)           // compiles
 *
 * A stray Number() on this path is what reintroduces the precision bug T4
 * exists to prevent, and a plain `.toString()` is how it gets in. Both are now
 * compile errors rather than something a reviewer has to notice.
 */

declare const U256_BRAND: unique symbol;

/** A uint256 rendered as a decimal string. Only u256() can make one. */
export type U256String = string & { readonly [U256_BRAND]: true };

/** The only way a bigint becomes a storable string. */
export function u256(value: bigint): U256String {
  if (value < 0n) {
    throw new Error(`uint256 cannot be negative: ${value}`);
  }
  return value.toString() as U256String;
}

/** Nullable form, for the many optional cost and gas columns. */
export function u256OrNull(value: bigint | null | undefined): U256String | null {
  return value === null || value === undefined ? null : u256(value);
}

/**
 * The one legitimate bigint -> number conversion, guarded.
 *
 * Block numbers are INTEGER in the validated schema and no chain's height
 * approaches 2^53, so the conversion is safe in practice - but it is checked
 * anyway, because "safe in practice" is how silent rounding gets in. A value
 * that would lose precision throws instead of being quietly truncated.
 */
export function blockNumberToInt(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `block number ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be stored as INTEGER without loss`,
    );
  }
  return Number(value);
}

/** Same guard for chain-clock seconds, which are also INTEGER columns. */
export function timestampToInt(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`block timestamp ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Domain -> row mappers. Callers hand over domain objects holding bigint and
// never construct a row themselves, so the conversion cannot be skipped.
// ---------------------------------------------------------------------------

export function toRunRow(run: RunRecord): RunRow {
  return {
    run_id: run.runId,
    experiment_id: run.experimentId,
    idempotency_key: run.idempotencyKey,
    path: run.path,
    tx_kind: run.txKind,
    sender: run.sender,
    nonce: run.nonce,
    gas_limit: u256OrNull(run.gasLimit),
    calldata_bytes: run.calldataBytes,
    l1_tx_hash: run.l1TxHash,
    l1_force_hash: run.l1ForceHash,
    l2_tx_hash: run.l2TxHash,
    outcome: run.outcome,
    retry_count: run.retryCount,
    error: run.error,
    submitted_at: run.submittedAt,
  };
}

export function toLifecycleEventRow(event: LifecycleEvent): LifecycleEventRow {
  return {
    event_id: event.eventId,
    run_id: event.runId,
    stage: event.stage,
    chain_layer: event.chainLayer,
    block_number: blockNumberToInt(event.blockNumber),
    block_timestamp: timestampToInt(event.blockTimestamp),
    observed_at: event.observedAt,
    clock_source: event.clockSource,
    confidence: event.confidence,
    finalized: event.finalized ? 1 : 0,
    raw_ref: event.rawRef,
  };
}

export function toCostRow(cost: CostRecord): CostRow {
  return {
    run_id: cost.runId,
    l1_gas_used: u256OrNull(cost.l1GasUsed),
    l1_gas_price: u256OrNull(cost.l1GasPrice),
    l1_fee_wei: u256OrNull(cost.l1FeeWei),
    force_gas_used: u256OrNull(cost.forceGasUsed),
    force_fee_wei: u256OrNull(cost.forceFeeWei),
    l2_gas_used: u256OrNull(cost.l2GasUsed),
    l2_fee_wei: u256OrNull(cost.l2FeeWei),
    total_fee_wei: u256OrNull(cost.totalFeeWei),
    l1_base_fee_at_submit: u256OrNull(cost.l1BaseFeeAtSubmit),
    op_l1_data_fee_wei: u256OrNull(cost.opL1DataFeeWei),
    op_l1_gas_used: u256OrNull(cost.opL1GasUsed),
    op_l1_gas_price: u256OrNull(cost.opL1GasPrice),
    arb_l1_gas_allocation: u256OrNull(cost.arbL1GasAllocation),
  };
}
