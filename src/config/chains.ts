import type { Address } from "viem";

/**
 * Chain registry.
 *
 * PROVENANCE RULE: every address carries a `source` and `checked` field.
 * Anything marked UNVERIFIED must be resolved before it is used in an
 * experiment, and the resolution must be recorded in the params snapshot.
 */

export type Verification = "verified" | "UNVERIFIED";

export interface AddressRef {
  address: Address | null;
  source: string;
  checked: string; // ISO date the value was last confirmed
  verification: Verification;
}

export type ProtocolFamily = "arbitrum-nitro" | "op-stack" | "zk-stack";

export interface L1Config {
  key: "eth-sepolia";
  chainId: number;
  rpcEnv: string;
  blockTimeSec: number;
}

export interface L2Config {
  key: string;
  family: ProtocolFamily;
  chainId: number;
  rpcEnv: string;
  /** L1 the rollup settles to */
  l1: L1Config["key"];
  /** Nominal L2 block time in seconds; used only for granularity reporting. */
  blockTimeSec: number;
  /** Contracts that live on L1 and mediate the forced path. */
  l1Contracts: Record<string, AddressRef>;
  /**
   * Protocol-stated bound on the forced path, in seconds.
   * `null` means it must be read on-chain or from the rollup config at runtime.
   */
  statedForcedBoundSec: number | null;
  /**
   * Where `statedForcedBoundSec` came from. Travels WITH the value so no caller
   * can attach a generic source label to a number that has no such source.
   * `null` whenever `statedForcedBoundSec` is null - an unsourced value must
   * never be reported as though it had provenance.
   */
  statedForcedBoundSource: string | null;
  notes: string;
}

export const ETH_SEPOLIA: L1Config = {
  key: "eth-sepolia",
  chainId: 11155111,
  rpcEnv: "RPC_ETH_SEPOLIA",
  blockTimeSec: 12,
};

export const ARB_SEPOLIA: L2Config = {
  key: "arb-sepolia",
  family: "arbitrum-nitro",
  chainId: 421614,
  rpcEnv: "RPC_ARB_SEPOLIA",
  l1: "eth-sepolia",
  blockTimeSec: 0.25,
  l1Contracts: {
    sequencerInbox: {
      address: "0x6c97864CE4bEf387dE0b3310A44230f7E3F1be0D",
      source: "Arbitrum Docs - smart contract addresses",
      checked: "2026-08-27",
      verification: "verified",
    },
    inbox: {
      address: "0xaAe29B0366299461418F5324a79Afc425BE5ae21",
      source: "Arbitrum Docs - smart contract addresses",
      checked: "2026-08-27",
      verification: "verified",
    },
    bridge: {
      address: "0x38f918D0E9F1b721EDaA41302E399fa1B79333a9",
      source: "Arbitrum Docs - smart contract addresses",
      checked: "2026-08-27",
      verification: "verified",
    },
    rollup: {
      address: "0xd80810638dbDF9081b72C1B33c65375e807281C8",
      source: "Arbitrum Docs - smart contract addresses",
      checked: "2026-08-27",
      verification: "verified",
    },
    outbox: {
      address: "0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F",
      source: "Arbitrum Docs - smart contract addresses",
      checked: "2026-08-27",
      verification: "verified",
    },
  },
  // Read from SequencerInbox.maxTimeVariation() at runtime. Do NOT hardcode
  // 86400 - the testnet value may differ from Arbitrum One.
  statedForcedBoundSec: null,
  statedForcedBoundSource: null, // read live from SequencerInbox.maxTimeVariation()
  notes:
    "Forced path: Inbox.sendL2Message -> delayed inbox -> wait delay -> SequencerInbox.forceInclude. User action required.",
};

export const OP_SEPOLIA: L2Config = {
  key: "op-sepolia",
  family: "op-stack",
  chainId: 11155420,
  rpcEnv: "RPC_OP_SEPOLIA",
  l1: "eth-sepolia",
  blockTimeSec: 2,
  l1Contracts: {
    optimismPortal: {
      // CORRECTED 2026-09-07. The previous value 0xfcbb237388CaF5b08175C9927a37aB6450acd535
      // was NOT the proxy despite being labelled "OptimismPortal2 proxy": on
      // Ethereum Sepolia it has an EMPTY EIP-1967 implementation slot, 42158
      // chars of bytecode, version() 3.10.0, and systemConfig() == address(0).
      // It is an orphaned implementation contract. depositTransaction() sent
      // there would emit from a non-canonical address, never be picked up by
      // derivation, and strand the ETH.
      address: "0x16Fc5058F25648194471939df75CF27A2fdC48BC",
      source:
        "superchain-registry superchain/configs/sepolia/op.toml OptimismPortalProxy; verified on-chain via portal.systemConfig().l2ChainId() == 11155420 and non-empty EIP-1967 impl slot on Ethereum Sepolia",
      checked: "2026-09-07",
      verification: "verified",
    },
  },
  statedForcedBoundSec: 3600 * 12,
  statedForcedBoundSource:
    "superchain-registry superchain/configs/sepolia/op.toml seq_window_size = 3600 L1 blocks x 12s = 43200s (rollup config, not on-chain)",
  notes:
    "Forced path: OptimismPortal.depositTransaction -> TransactionDeposited -> derivation includes as type 0x7E. No user force call.",
};

export const BASE_SEPOLIA: L2Config = {
  key: "base-sepolia",
  family: "op-stack",
  chainId: 84532,
  rpcEnv: "RPC_BASE_SEPOLIA",
  l1: "eth-sepolia",
  blockTimeSec: 2,
  l1Contracts: {
    optimismPortal: {
      address: "0x49f53e41452C74589E85cA1677426Ba426459e85",
      // NOTE: Base is absent from ethereum-optimism/superchain-registry - its
      // chainList.json enumerates 54 chains and contains neither 8453 nor 84532,
      // so the originally intended source cannot supply this value. Taken from
      // Base's first-party docs instead, then bound to Base Sepolia ON-CHAIN:
      // portal.version() = 5.2.0; portal.systemConfig() =
      // 0xf272670eb55e895584501d564AfEB048bEd26194; that SystemConfig's
      // l2ChainId() returns 84532. The chain itself, not the doc page, is what
      // establishes this address belongs to Base Sepolia.
      source:
        "docs.base.org/base-chain/network-information/base-contracts; verified on-chain via portal.systemConfig().l2ChainId() == 84532 on Ethereum Sepolia",
      checked: "2026-09-07",
      verification: "verified",
    },
  },
  // UNVERIFIED. The previous value (3600 * 12) was inherited from OP Sepolia and
  // labelled as coming from superchain-registry, but Base is absent from that
  // registry entirely (chainList.json lists 54 chains; neither 8453 nor 84532).
  // base/node ships no rollup.json either - it resolves BASE_NODE_NETWORK=
  // base-sepolia internally - so no first-party value could be cited. Null
  // rather than a plausible guess: see CLAUDE.md I1.
  statedForcedBoundSec: null,
  statedForcedBoundSource: null,
  notes:
    "Same stack as OP Sepolia. Serves as intra-family replication check, not a separate architecture. Sequencing window UNVERIFIED - resolve before Base is used for any bound-related claim.",
};

export const L1S: Record<string, L1Config> = {
  [ETH_SEPOLIA.key]: ETH_SEPOLIA,
};

export const L2S: Record<string, L2Config> = {
  [ARB_SEPOLIA.key]: ARB_SEPOLIA,
  [OP_SEPOLIA.key]: OP_SEPOLIA,
  [BASE_SEPOLIA.key]: BASE_SEPOLIA,
};

export function unverifiedRefs(): Array<{ chain: string; contract: string; source: string }> {
  const out: Array<{ chain: string; contract: string; source: string }> = [];
  for (const [chainKey, cfg] of Object.entries(L2S)) {
    for (const [name, ref] of Object.entries(cfg.l1Contracts)) {
      if (ref.verification === "UNVERIFIED" || ref.address === null) {
        out.push({ chain: chainKey, contract: name, source: ref.source });
      }
    }
  }
  return out;
}
