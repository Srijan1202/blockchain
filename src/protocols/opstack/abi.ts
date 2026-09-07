/**
 * Minimal OptimismPortal ABI - only the members actually used.
 *
 * Deliberately not the full contract ABI: a trimmed ABI makes it obvious which
 * on-chain surface this study depends on, and stops an unrelated upgrade to
 * some other method looking like a change to ours.
 */

export const OPTIMISM_PORTAL_DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
      { name: "_gasLimit", type: "uint64" },
      { name: "_isCreation", type: "bool" },
      { name: "_data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "TransactionDeposited",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "version", type: "uint256", indexed: true },
      { name: "opaqueData", type: "bytes", indexed: false },
    ],
  },
] as const;
