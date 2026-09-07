/**
 * Minimal Arbitrum Nitro ABIs - only the members actually used.
 *
 * Trimmed on purpose: it makes the on-chain surface this study depends on
 * explicit, and stops an unrelated upgrade elsewhere looking like a change to
 * ours.
 */

/** Delayed Inbox. sendL2Message is the escape-hatch entry point. */
export const INBOX_ABI = [
  {
    type: "function",
    name: "sendL2Message",
    stateMutability: "nonpayable",
    inputs: [{ name: "messageData", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "InboxMessageDelivered",
    inputs: [
      { name: "messageNum", type: "uint256", indexed: true },
      { name: "data", type: "bytes", indexed: false },
    ],
  },
] as const;

/**
 * Bridge. MessageDelivered carries exactly the fields forceInclude() needs:
 * kind, sender, messageDataHash and baseFeeL1. Without this event the force
 * call cannot be constructed.
 */
export const BRIDGE_ABI = [
  {
    type: "event",
    name: "MessageDelivered",
    inputs: [
      { name: "messageIndex", type: "uint256", indexed: true },
      { name: "beforeInboxAcc", type: "bytes32", indexed: true },
      { name: "inbox", type: "address", indexed: false },
      { name: "kind", type: "uint8", indexed: false },
      { name: "sender", type: "address", indexed: false },
      { name: "messageDataHash", type: "bytes32", indexed: false },
      { name: "baseFeeL1", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
    ],
  },
] as const;

export const SEQUENCER_INBOX_ABI = [
  {
    type: "function",
    name: "forceInclude",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_totalDelayedMessagesRead", type: "uint256" },
      { name: "kind", type: "uint8" },
      { name: "l1BlockAndTime", type: "uint64[2]" },
      { name: "baseFeeL1", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "messageDataHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "totalDelayedMessagesRead",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxTimeVariation",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "delayBlocks", type: "uint256" },
      { name: "futureBlocks", type: "uint256" },
      { name: "delaySeconds", type: "uint256" },
      { name: "futureSeconds", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "SequencerBatchDelivered",
    inputs: [
      { name: "batchSequenceNumber", type: "uint256", indexed: true },
      { name: "beforeAcc", type: "bytes32", indexed: true },
      { name: "afterAcc", type: "bytes32", indexed: true },
    ],
  },
] as const;

/**
 * Message kinds, from Nitro's Messages.sol. Only L2_MSG is produced by this
 * harness; the others appear in the same delayed inbox and must not be
 * mistaken for escape-hatch usage when indexing (see T13 Class B).
 */
export const MESSAGE_KIND = {
  /** sendL2Message - the escape-hatch path. */
  L2_MSG: 3,
  L1MessageType_submitRetryableTx: 9,
  L1MessageType_ethDeposit: 12,
  L1MessageType_batchPostingReport: 13,
} as const;

/**
 * L2 message sub-types, from Messages.sol. 4 wraps a complete, already-signed
 * L2 transaction, which is what lets the harness know the L2 tx hash before it
 * ever submits to L1.
 */
export const L2_MESSAGE_TYPE = {
  signedTx: 4,
} as const;
