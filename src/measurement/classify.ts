import type { Address, Hex } from "viem";
import type { MainnetClass } from "../storage/db.js";

/**
 * Mainnet event classification (BLUEPRINT section 12).
 *
 * Pure decision rules, no I/O. The indexer gathers evidence; this file decides
 * what the evidence supports and writes down why. Keeping the two apart means
 * the class boundaries can be read and argued with on their own, which is the
 * part a reviewer will actually attack.
 *
 * THE RULE THAT MATTERS MOST: a class is never upgraded to improve a count.
 * Section 12 expects Class A on Arbitrum mainnet to be tiny - possibly single
 * digits across all history - and says plainly that if so, THAT IS THE FINDING.
 * The pressure this file exists to resist is the temptation to let a
 * nearly-Class-A event count as Class A. Every function below therefore
 * degrades toward D, never toward A, and every return carries the evidence
 * string that justifies it.
 *
 * Class D is not failure. It is the honest label for an event whose evidence
 * ran out - usually at a scan boundary, where the observation that would settle
 * the class lies outside the range we looked at. Reclassifying those as C to
 * tidy the output would inflate the "ordinary inclusion" population with events
 * we simply did not examine.
 */

/** Selector of forceInclusion(uint256,uint8,uint64[2],uint256,address,bytes32). */
export const FORCE_INCLUSION_SELECTOR = "0xf1981578";

/**
 * IBridge.BatchDataLocation. Order is load-bearing - NoData is the marker that
 * a batch carried no sequencer data, which is what forceInclusion produces.
 * Read from nitro-contracts src/bridge/IBridge.sol, not assumed.
 */
export const BATCH_DATA_LOCATION = {
  TxInput: 0,
  SeparateBatchEvent: 1,
  NoData: 2,
  Blob: 3,
} as const;

/** Arbitrum's L1MessageType for a signed L2 transaction via the delayed inbox. */
export const L2_MSG_KIND = 3;

export interface Classified {
  class: MainnetClass;
  evidence: string;
}

/**
 * Evidence available about one SequencerBatchDelivered whose dataLocation is
 * NoData - the Class A candidate set.
 */
export interface ForceCandidate {
  txHash: Hex;
  dataLocation: number;
  /** null when the transaction could not be fetched. */
  inputSelector: string | null;
  /** null when the receipt could not be fetched. Anything but 1 is not success. */
  receiptStatus: "success" | "reverted" | null;
  /** Was the call sent directly to the SequencerInbox we are indexing? */
  toIsSequencerInbox: boolean | null;
}

/**
 * Class A requires all four: a NoData batch, a transaction whose selector is
 * forceInclusion, a successful receipt, and a direct call to the inbox.
 *
 * Each condition removes a specific false positive:
 *  - NoData alone would admit any future batch type that carries no data.
 *  - The selector alone would admit a reverted attempt, which is emphatically
 *    not a confirmed forced inclusion (though under I6 a revert is data worth
 *    keeping - the indexer records it as D with the revert in its evidence).
 *  - The receipt check is what "successful" in section 12 actually means.
 *  - The direct-call check keeps a proxy or aggregator that happens to embed
 *    the same selector from being counted without inspection.
 *
 * Anything short of all four returns D with the failing condition named.
 */
export function classifyForceCandidate(c: ForceCandidate): Classified {
  const parts: string[] = [`SequencerBatchDelivered dataLocation=${c.dataLocation}`];

  if (c.dataLocation !== BATCH_DATA_LOCATION.NoData) {
    return { class: "D", evidence: `${parts.join("; ")}; not NoData, so not a force-inclusion batch` };
  }
  parts.push("NoData");

  if (c.inputSelector === null) {
    return { class: "D", evidence: `${parts.join("; ")}; transaction ${c.txHash} could not be fetched, selector unverified` };
  }
  parts.push(`selector=${c.inputSelector}`);

  if (c.inputSelector.toLowerCase() !== FORCE_INCLUSION_SELECTOR) {
    return {
      class: "D",
      evidence: `${parts.join("; ")}; NoData batch NOT produced by forceInclusion (${FORCE_INCLUSION_SELECTOR}) - unexplained, kept as D rather than assumed`,
    };
  }

  if (c.toIsSequencerInbox === false) {
    return { class: "D", evidence: `${parts.join("; ")}; call was not sent directly to the indexed SequencerInbox` };
  }

  if (c.receiptStatus === null) {
    return { class: "D", evidence: `${parts.join("; ")}; receipt unavailable, success unverified` };
  }
  if (c.receiptStatus !== "success") {
    // I6: a reverting forceInclusion is potentially the most interesting result
    // in the project. It is not Class A - nothing was included - but it is
    // recorded loudly rather than dropped.
    return { class: "D", evidence: `${parts.join("; ")}; forceInclusion REVERTED - attempted but not confirmed (I6: recorded, not discarded)` };
  }

  return {
    class: "A",
    evidence: `${parts.join("; ")}; receipt=success; direct call to SequencerInbox - confirmed forced inclusion`,
  };
}

/**
 * Evidence about one delayed message and when the sequencer actually read it.
 */
export interface DelayedMessageObservation {
  messageIndex: bigint;
  kind: number;
  /** L1 block the MessageDelivered event was emitted in. */
  deliveredBlock: bigint;
  /**
   * L1 block of the first SequencerBatchDelivered whose afterDelayedMessagesRead
   * exceeded this index. null when no such batch was found in the scanned range.
   */
  readBlock: bigint | null;
  /**
   * The inbox's own on-chain buffer threshold, in L1 blocks: "the maximum amount
   * of blocks that a message is expected to be delayed" (DelayBufferTypes.sol).
   * Read live from SequencerInbox.buffer(), never a constant chosen here - I1.
   */
  thresholdBlocks: bigint | null;
  /** True when the message was swept in by a confirmed forceInclusion. */
  forcedIn: boolean;
}

/**
 * Class B is "not read within the normal window, later batched".
 *
 * "Normal window" is the one phrase in section 12 that could be filled in with
 * an invented constant, so it is filled in from the protocol instead: Arbitrum's
 * delay buffer carries a `threshold` documented as the maximum number of blocks
 * a message is EXPECTED to be delayed. That is the protocol's own definition of
 * normal, it is readable on-chain, and using it satisfies I1 rather than
 * working around it. If the threshold could not be read, no Class B judgement
 * is made at all - the message becomes D, because without a boundary the
 * question is unanswerable rather than answerable-as-C.
 */
export function classifyDelayedMessage(m: DelayedMessageObservation): Classified {
  const base = `MessageDelivered index=${m.messageIndex} kind=${m.kind} deliveredBlock=${m.deliveredBlock}`;

  if (m.forcedIn) {
    // The forceInclusion call itself is the Class A row. This message is
    // evidence attached to it, not a second Class A event - counting both would
    // double-count the one thing section 12 says must be unambiguous.
    return { class: "B", evidence: `${base}; swept in by a confirmed forceInclusion - see the Class A row for that call` };
  }

  if (m.readBlock === null) {
    return {
      class: "D",
      evidence: `${base}; no SequencerBatchDelivered covering this index within the scanned range - insufficient evidence, NOT assumed ordinary`,
    };
  }

  const delay = m.readBlock - m.deliveredBlock;

  if (m.thresholdBlocks === null) {
    return {
      class: "D",
      evidence: `${base}; readBlock=${m.readBlock} delay=${delay} blocks, but the on-chain buffer threshold could not be read, so "normal window" has no value to compare against (I1: not substituted)`,
    };
  }

  if (delay > m.thresholdBlocks) {
    return {
      class: "B",
      evidence: `${base}; readBlock=${m.readBlock} delay=${delay} blocks EXCEEDS on-chain buffer threshold ${m.thresholdBlocks} - sequencer lagged; suggestive, not proof of censorship`,
    };
  }

  return {
    class: "C",
    evidence: `${base}; readBlock=${m.readBlock} delay=${delay} blocks within on-chain buffer threshold ${m.thresholdBlocks} - ordinary sequenced inclusion`,
  };
}

/**
 * OP Stack deposits are Class C by construction, and that is a finding rather
 * than a shortcut.
 *
 * TransactionDeposited is the same event whether it carries a routine bridge
 * deposit or a user routing around a down sequencer, and the population is
 * overwhelmingly the former. Section 12 calls this "exactly the confound that
 * sank the naive version of this study". There is no field on the event that
 * separates the two, so no amount of care here can promote one to Class A;
 * pretending otherwise is the error being guarded against. Report OP deposits
 * as MECHANISM USAGE, never as censorship.
 */
export function classifyOpDeposit(args: {
  from: Address;
  to: Address;
  isFromStandardBridge: boolean;
  opaqueDataBytes: number;
}): Classified {
  const origin = args.isFromStandardBridge ? "standard bridge" : "direct/unknown sender";
  return {
    class: "C",
    evidence:
      `TransactionDeposited from=${args.from} to=${args.to} (${origin}) opaqueData=${args.opaqueDataBytes}B; ` +
      `OP Stack deposits are Class C BY CONSTRUCTION - the event cannot distinguish routine bridging from ` +
      `censorship circumvention, so it is mechanism usage, never evidence of censorship`,
  };
}
