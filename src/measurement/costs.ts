import type { Hex, PublicClient } from "viem";
import type { ProtocolFamily } from "../config/chains.js";
import type { CostRecord, SubmissionRef } from "../core/types.js";

/**
 * Cost collection.
 *
 * Lives here rather than in the CLI because it is measurement logic and because
 * re-collecting costs for an already-submitted run must be possible without
 * going through a campaign - the receipt stays on chain, so a cost row can be
 * repaired long after the fact without spending anything.
 *
 * THE DATA-AVAILABILITY COMPONENT, and why the two protocols need different
 * handling (see migration 003 for the full note):
 *
 *   OP Stack   gasUsed x effectiveGasPrice covers L2 EXECUTION ONLY. The L1
 *              data fee is charged separately and appears as `l1Fee` on the
 *              receipt. It must be read and ADDED to the total. Measured at
 *              ~45% of the true cost on a real OP Sepolia transfer, so omitting
 *              it is not a rounding issue.
 *
 *   Arbitrum   gasUsed x effectiveGasPrice is ALREADY INCLUSIVE. Nitro recoups
 *              the posting cost by charging extra L2 gas, reported as
 *              `gasUsedForL1` - a subset of gasUsed, in gas units, priced at
 *              the L2 gas price. It is recorded for description only and must
 *              NOT be added to the total; doing so would double-count.
 *
 * These two quantities are not interchangeable and must never be summed or
 * compared across protocols. Only totals are comparable.
 */

/**
 * Non-standard receipt fields, read from the raw JSON-RPC response.
 *
 * viem's typed receipt drops fields it does not know about, and both the OP
 * Stack's l1Fee family and Arbitrum's gasUsedForL1 are exactly that. So the
 * receipt is fetched raw and validated here rather than trusted (I7).
 */
interface RawReceipt {
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
  /** OP Stack: the separately-charged L1 data fee, in wei, L1-priced. */
  l1Fee: bigint | null;
  l1GasUsed: bigint | null;
  l1GasPrice: bigint | null;
  /** Arbitrum: L2 gas allocated to L1 posting. A SUBSET of gasUsed. */
  gasUsedForL1: bigint | null;
}

function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function requireBigInt(value: unknown, field: string): bigint {
  const parsed = hexToBigInt(value);
  if (parsed === null) throw new Error(`receipt field ${field} missing or not a quantity`);
  return parsed;
}

/** Fetch a receipt raw, so protocol-specific fee fields survive. */
async function rawReceipt(client: PublicClient, hash: Hex): Promise<RawReceipt> {
  const result: unknown = await client.request({
    method: "eth_getTransactionReceipt" as never,
    params: [hash] as never,
  });
  if (result === null || typeof result !== "object") {
    throw new Error("receipt not found");
  }
  const r = result as Record<string, unknown>;
  return {
    gasUsed: requireBigInt(r.gasUsed, "gasUsed"),
    effectiveGasPrice: requireBigInt(r.effectiveGasPrice, "effectiveGasPrice"),
    blockNumber: requireBigInt(r.blockNumber, "blockNumber"),
    l1Fee: hexToBigInt(r.l1Fee),
    l1GasUsed: hexToBigInt(r.l1GasUsed),
    l1GasPrice: hexToBigInt(r.l1GasPrice),
    gasUsedForL1: hexToBigInt(r.gasUsedForL1),
  };
}

export function emptyCosts(runId: string): CostRecord {
  return {
    runId,
    l1GasUsed: null,
    l1GasPrice: null,
    l1FeeWei: null,
    forceGasUsed: null,
    forceFeeWei: null,
    l2GasUsed: null,
    l2FeeWei: null,
    totalFeeWei: null,
    l1BaseFeeAtSubmit: null,
    opL1DataFeeWei: null,
    opL1GasUsed: null,
    opL1GasPrice: null,
    arbL1GasAllocation: null,
  };
}

/**
 * Costs from the receipts, where there are receipts to read.
 *
 * Returns undefined when no leg produced a receipt - absence of observation
 * must not be written as a row of nulls.
 */
export async function collectCosts(
  runId: string,
  ref: SubmissionRef,
  family: ProtocolFamily,
  l1: PublicClient,
  l2: PublicClient,
): Promise<CostRecord | undefined> {
  if (ref.l1TxHash === null && ref.l2TxHash === null) return undefined;
  const costs = emptyCosts(runId);

  // A leg is "expected" when the submission produced a hash for it. Tracking
  // may have timed out with some legs mined and others not; partial costs are
  // legitimate data and are recorded, but the TOTAL is only meaningful when
  // every expected leg was actually observed.
  let expected = 0;
  let observed = 0;
  let total = 0n;

  if (ref.l1TxHash !== null) {
    expected++;
    try {
      const r = await l1.getTransactionReceipt({ hash: ref.l1TxHash });
      costs.l1GasUsed = r.gasUsed;
      costs.l1GasPrice = r.effectiveGasPrice;
      costs.l1FeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.l1FeeWei;
      const block = await l1.getBlock({ blockNumber: r.blockNumber });
      costs.l1BaseFeeAtSubmit = block.baseFeePerGas ?? null;
      observed++;
    } catch {
      /* not mined; leave null rather than guess */
    }
  }
  if (ref.l1ForceHash !== null) {
    expected++;
    try {
      const r = await l1.getTransactionReceipt({ hash: ref.l1ForceHash });
      costs.forceGasUsed = r.gasUsed;
      costs.forceFeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.forceFeeWei;
      observed++;
    } catch {
      /* not mined */
    }
  }
  if (ref.l2TxHash !== null) {
    expected++;
    try {
      const r = await rawReceipt(l2, ref.l2TxHash);
      costs.l2GasUsed = r.gasUsed;
      costs.l2FeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.l2FeeWei;

      if (family === "op-stack") {
        // Charged on top of L2 execution, so it is part of what the user paid
        // and belongs in the total.
        costs.opL1DataFeeWei = r.l1Fee;
        costs.opL1GasUsed = r.l1GasUsed;
        costs.opL1GasPrice = r.l1GasPrice;
        if (r.l1Fee !== null) total += r.l1Fee;
      } else if (family === "arbitrum-nitro") {
        // Recorded for description only. Already inside gasUsed above, so
        // adding it here would double-count the same wei.
        costs.arbL1GasAllocation = r.gasUsedForL1;
      }
      observed++;
    } catch {
      /* not included */
    }
  }

  // No receipt anywhere: nothing was observed, so no row (see the write site).
  if (observed === 0) return undefined;

  // Withhold the total on a partial observation rather than reporting a sum
  // that silently omits a leg - M-C4 would be understated and look like a
  // cheaper forced path than it was.
  costs.totalFeeWei = observed === expected ? total : null;
  return costs;
}
