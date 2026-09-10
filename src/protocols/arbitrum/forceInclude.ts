import { keccak256, type Address, type Hex } from "viem";
import { L2_MESSAGE_TYPE } from "./abi.js";

/**
 * Delayed-inbox mechanics and the forceInclusion leg.
 *
 * VALIDATED read-only against Arbitrum Sepolia (2026-09-07):
 *   - messageDataHash == keccak256(messageData), confirmed on 5 real
 *     MessageDelivered events. Getting this wrong makes forceInclusion revert.
 *   - an L2 transaction hash is keccak256 of its signed serialization,
 *     confirmed on 3 real Arbitrum Sepolia transactions. That is why
 *     submitForced knows the L2 hash at signing time, before submitting.
 */

/**
 * Wrap an already-signed L2 transaction for Inbox.sendL2Message.
 *
 * The delayed inbox takes an opaque message whose first byte is the L2 message
 * type; 4 means "a complete signed transaction, execute it as-is". Because the
 * transaction is signed before it is wrapped, its L2 hash is already determined
 * and the harness can poll for it without deriving anything.
 */
export function wrapSignedL2Message(signedTx: Hex): Hex {
  const typeByte = L2_MESSAGE_TYPE.signedTx.toString(16).padStart(2, "0");
  return (`0x${typeByte}${signedTx.slice(2)}`) as Hex;
}

/** The L2 transaction hash of a signed transaction. */
export function l2TxHashOf(signedTx: Hex): Hex {
  return keccak256(signedTx);
}

/** messageDataHash as the Bridge computes it, and as forceInclusion expects it. */
export function messageDataHashOf(messageData: Hex): Hex {
  return keccak256(messageData);
}

/**
 * Everything forceInclusion() needs about the queued message.
 *
 * These come from the Bridge's MessageDelivered event plus the L1 block that
 * carried it. They cannot be reconstructed from the Inbox event alone.
 */
export interface DelayedMessage {
  messageIndex: bigint;
  kind: number;
  sender: Address;
  messageDataHash: Hex;
  baseFeeL1: bigint;
  /** L1 block number the message was delivered in. */
  l1BlockNumber: bigint;
  /** The Bridge's recorded timestamp for the message. */
  l1Timestamp: bigint;
}

export interface ForceIncludeArgs {
  totalDelayedMessagesRead: bigint;
  kind: number;
  l1BlockAndTime: readonly [bigint, bigint];
  baseFeeL1: bigint;
  sender: Address;
  messageDataHash: Hex;
}

/**
 * Build the forceInclusion arguments for a queued message.
 *
 * `_totalDelayedMessagesRead` is the count to read UP TO, so it is the
 * message's index plus one: forcing message N means the sequencer inbox has
 * now read N+1 delayed messages.
 */
export function buildForceIncludeArgs(message: DelayedMessage): ForceIncludeArgs {
  return {
    totalDelayedMessagesRead: message.messageIndex + 1n,
    kind: message.kind,
    l1BlockAndTime: [message.l1BlockNumber, message.l1Timestamp] as const,
    baseFeeL1: message.baseFeeL1,
    sender: message.sender,
    messageDataHash: message.messageDataHash,
  };
}

export interface ForceEligibility {
  /** Earliest L1 timestamp at which the force call can succeed. */
  eligibleAtSeconds: bigint;
  /** Earliest L1 block number at which it can succeed. */
  eligibleAtBlock: bigint;
  /** The live values this was computed from, for the record. */
  delaySeconds: bigint;
  delayBlocks: bigint;
}

/**
 * Compute S5, force eligibility.
 *
 * S5 is the ONLY inferred stage in the study. It is not witnessed on chain:
 * it is derived from the message's L1 timestamp plus the delaySeconds read
 * live from maxTimeVariation() at run time. It must therefore always be
 * recorded with confidence 'inferred', never 'observed' - and delaySeconds
 * must be read, never assumed, because Arbitrum One's 24h value is not
 * guaranteed to match any other chain's (I1).
 */
export function computeForceEligibility(
  message: DelayedMessage,
  delaySeconds: bigint,
  delayBlocks: bigint,
): ForceEligibility {
  return {
    eligibleAtSeconds: message.l1Timestamp + delaySeconds,
    eligibleAtBlock: message.l1BlockNumber + delayBlocks,
    delaySeconds,
    delayBlocks,
  };
}

/**
 * Whether the force leg can ever succeed in this environment.
 *
 * BLUEPRINT section 20.1: on a healthy public testnet it cannot. forceInclusion
 * only acts on messages the sequencer has NOT yet read, but a healthy sequencer
 * reads the delayed inbox voluntarily in about ten minutes - hours before a
 * 24h window opens. The two conditions "delay elapsed" and "message still
 * unread" cannot both hold, so waiting longer makes it worse, not better.
 *
 * Returning a reason rather than a bare boolean so the refusal can be logged
 * and recorded rather than silently swallowed.
 */
export interface ForceReachability {
  reachable: boolean;
  reason: string;
}

export function assessForceReachability(
  environment: "devnet" | "testnet" | "mainnet",
  delaySeconds: bigint,
): ForceReachability {
  if (environment === "devnet") {
    return {
      reachable: true,
      reason: `devnet: the sequencer's delayed-message reader is under our control and delaySeconds is ${delaySeconds}`,
    };
  }
  return {
    reachable: false,
    reason:
      `${environment}: forceInclusion only acts on messages the sequencer has not yet read, but a healthy ` +
      `sequencer reads the delayed inbox in ~10 minutes while delaySeconds is ${delaySeconds} ` +
      `(~${Number(delaySeconds) / 3600}h). The message will have been auto-included long before it becomes ` +
      `force-eligible, so the call cannot succeed. This is structural, not a timing problem - see BLUEPRINT 20.1.`,
  };
}

/**
 * How a transaction reached L2.
 *
 * Recorded explicitly rather than left to be inferred from the absence of an S6
 * row, so a reader cannot mistake "we did not force it" for "we did not record
 * the force". On a healthy sequencer the delayed message is read voluntarily:
 * that is AUTO-inclusion and must never be described as a forced inclusion or
 * as censorship recovery (I4).
 */
export type InclusionPath = "auto" | "forced" | "unknown";

export function classifyInclusion(sawForceAction: boolean, reachedL2: boolean): InclusionPath {
  if (!reachedL2) return "unknown";
  return sawForceAction ? "forced" : "auto";
}

/** Machine-readable marker stored in lifecycle_events.raw_ref for S7. */
export function inclusionRawRef(path: InclusionPath, l2TxHash: Hex): string {
  return `inclusion=${path};tx=${l2TxHash}`;
}
