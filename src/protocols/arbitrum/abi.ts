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
 * Bridge. MessageDelivered carries exactly the fields forceInclusion() needs:
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
    /**
     * The external name is `forceInclusion`, NOT `forceInclude`. The glossary
     * name and the name this file carried until 2026-09-10 produce a different
     * 4-byte selector, so the call hit the proxy fallback and reverted with no
     * data. It never fired because BLUEPRINT 20.1 makes the force leg
     * unreachable on healthy public testnets - E1 is the first place it runs.
     *
     * Verified per chain rather than assumed, since these are three separate
     * deployments. For this argument list:
     *   forceInclusion(...) = 0xf1981578   forceInclude(...) = 0xd8774d5a
     * Resolved each proxy's EIP-1967 implementation and searched its dispatch
     * table; corroborated with eth_call (0xf1981578 reverts DelayedBackwards(),
     * i.e. it dispatches; 0xd8774d5a reverts with no data, i.e. it does not):
     *   devnet           0x60FFA00eaC35597FAAb2b2B5926e5b0CddF5700c  impl 0xb075b82c7a23e0994dF4793422A1f03Dbcf9136F
     *   Arbitrum Sepolia 0x6c97864CE4bEf387dE0b3310A44230f7E3F1be0D  impl 0xBBb2EF6dD70759F6c335c116895c6749ec7427da
     *   Arbitrum One     0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6  impl 0x98a58ADAb0f8A66A1BF4544d804bc0475dff32c7
     * All three expose 0xf1981578 and none expose 0xd8774d5a.
     */
    type: "function",
    name: "forceInclusion",
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
