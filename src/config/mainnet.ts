import type { Address } from "viem";
import type { AddressRef } from "./chains.js";

/**
 * Observation targets for the mainnet indexer (T13 / BLUEPRINT section 12).
 *
 * WHY THIS IS NOT IN chains.ts. The registry there describes chains we RUN
 * EXPERIMENTS ON: it carries an rpcEnv, an L2 block time, a stated forced-path
 * bound, and an `l1` field typed to the single key "eth-sepolia". None of that
 * applies to a chain we only read history from, and widening L1Config to admit
 * mainnet would put fields on every testnet entry that no testnet uses.
 * CLAUDE.md section 4 says that if a change needs more than an adapter plus one
 * registry line, the abstraction is wrong - so this is a separate, smaller
 * registry for a genuinely different purpose.
 *
 * The provenance rule is NOT relaxed: AddressRef is reused verbatim, so every
 * address here carries source, checked and verification exactly as I2 requires.
 * Nothing in this file was taken from memory or documentation alone - each
 * address was confirmed by an on-chain read that ties it to the chain it claims
 * to belong to, recorded in `source`.
 */

/** Everything indexed here settles to Ethereum mainnet. */
export const OBSERVATION_L1_CHAIN_ID = 1;

/**
 * RPC for the L1 the targets live on.
 *
 * Deliberately its own variable rather than reusing RPC_ETH_SEPOLIA: pointing
 * a mainnet indexer at a testnet endpoint would silently produce an empty
 * result set that looks exactly like the "escape hatch is never used" finding.
 *
 * The indexer needs archive logs over wide ranges, which most free endpoints
 * refuse in one direction or the other - see docs in cli/index-mainnet.ts.
 */
export const MAINNET_RPC_ENV = "RPC_ETH_MAINNET";

export type TargetKind = "arbitrum-sequencer-inbox" | "arbitrum-bridge" | "optimism-portal";

export interface ObservationTarget {
  label: string;
  kind: TargetKind;
  ref: AddressRef;
}

export interface ObservedChain {
  key: string;
  family: "arbitrum-nitro" | "op-stack";
  /** The L2's own chain id. Used to verify OP portals, not to connect to. */
  l2ChainId: number;
  targets: ObservationTarget[];
}

const VERIFIED_ON = "2026-09-11";

export const OBSERVED_CHAINS: readonly ObservedChain[] = [
  {
    key: "arbitrum-one",
    family: "arbitrum-nitro",
    l2ChainId: 42161,
    targets: [
      {
        label: "SequencerInbox",
        kind: "arbitrum-sequencer-inbox",
        ref: {
          address: "0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6" as Address,
          // Cross-referenced both ways: this contract's bridge() returns the
          // Bridge below, and that Bridge's sequencerInbox() returns this.
          // A one-way check would pass for an orphaned implementation - the
          // failure mode that produced the bad OP Sepolia portal earlier.
          source:
            "on-chain: seqInbox.bridge() == 0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a and " +
            "bridge.sequencerInbox() == this; seqInbox.rollup() == 0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0",
          checked: VERIFIED_ON,
          verification: "verified",
        },
      },
      {
        label: "Bridge",
        kind: "arbitrum-bridge",
        ref: {
          address: "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a" as Address,
          source: "on-chain: bridge.sequencerInbox() == 0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6 (mutual)",
          checked: VERIFIED_ON,
          verification: "verified",
        },
      },
    ],
  },
  {
    key: "op-mainnet",
    family: "op-stack",
    l2ChainId: 10,
    targets: [
      {
        label: "OptimismPortal",
        kind: "optimism-portal",
        ref: {
          address: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed" as Address,
          // The portal is only trustworthy if it names the chain we think it
          // serves. systemConfig().l2ChainId() is that binding.
          source: "on-chain: portal.systemConfig() == 0x229047fed2591dbec1eF1118d64F7aF3dB9EB290, whose l2ChainId() == 10; portal.version() == 5.6.1",
          checked: VERIFIED_ON,
          verification: "verified",
        },
      },
    ],
  },
  {
    key: "base",
    family: "op-stack",
    l2ChainId: 8453,
    targets: [
      {
        label: "OptimismPortal",
        kind: "optimism-portal",
        ref: {
          address: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e" as Address,
          source: "on-chain: portal.systemConfig() == 0x73a79Fab69143498Ed3712e519A88a918e1f4072, whose l2ChainId() == 8453; portal.version() == 5.2.0",
          checked: VERIFIED_ON,
          verification: "verified",
        },
      },
    ],
  },
] as const;

export function observedChain(key: string): ObservedChain {
  const found = OBSERVED_CHAINS.find((c) => c.key === key);
  if (found === undefined) {
    throw new Error(`Unknown observed chain ${JSON.stringify(key)}. Known: ${OBSERVED_CHAINS.map((c) => c.key).join(", ")}`);
  }
  return found;
}

/**
 * Resolve one target's address, refusing anything unverified.
 *
 * I2: an UNVERIFIED address must make dependent code fail loudly rather than
 * fall back. Indexing the wrong contract yields zero events, and zero events is
 * indistinguishable from the finding this study is trying to establish - so a
 * silent fallback here would not merely be wrong, it would be wrong in the
 * direction that flatters the conclusion.
 */
export function targetAddress(chain: ObservedChain, kind: TargetKind): Address {
  const t = chain.targets.find((x) => x.kind === kind);
  if (t === undefined) throw new Error(`${chain.key} has no ${kind} target`);
  if (t.ref.verification !== "verified" || t.ref.address === null) {
    throw new Error(
      `Refusing to index ${chain.key}.${t.label}: address is ${t.ref.verification}. ` +
        `An unverified target produces an empty result set that looks exactly like the finding.`,
    );
  }
  return t.ref.address;
}
