import { createPublicClient, http, type PublicClient } from "viem";
import { ETH_SEPOLIA, L2S, type L2Config } from "../config/chains.js";

/**
 * Params snapshot.
 *
 * Rationale: Arbitrum's effective force-inclusion window is state-dependent
 * (BoLD delay buffer) and OP Stack's sequencing window is a rollup-config
 * value. Both can change between runs. Every experiment row must be joinable
 * to the parameter values that were live when it ran, or a mid-study upgrade
 * silently confounds the results.
 */

export const SEQUENCER_INBOX_ABI = [
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
    type: "function",
    name: "totalDelayedMessagesRead",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const OPTIMISM_PORTAL_ABI = [
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface ParamSnapshot {
  chainKey: string;
  family: string;
  takenAt: string;
  l1BlockNumber: string;
  values: Record<string, string>;
  errors: string[];
}

function rpc(envKey: string): string {
  const v = process.env[envKey];
  if (!v) throw new Error(`Missing env var ${envKey} (copy .env.example to .env)`);
  return v;
}

export function l1Client(): PublicClient {
  return createPublicClient({ transport: http(rpc(ETH_SEPOLIA.rpcEnv)) }) as PublicClient;
}

export function l2Client(cfg: L2Config): PublicClient {
  return createPublicClient({ transport: http(rpc(cfg.rpcEnv)) }) as PublicClient;
}

export async function snapshotParams(chainKey: string): Promise<ParamSnapshot> {
  const cfg = L2S[chainKey];
  if (!cfg) throw new Error(`Unknown chain ${chainKey}`);

  const snap: ParamSnapshot = {
    chainKey,
    family: cfg.family,
    takenAt: new Date().toISOString(),
    l1BlockNumber: "0",
    values: {},
    errors: [],
  };

  // The L1 client and block height gate every read below. A missing env var or
  // an unreachable RPC must be RECORDED, not thrown: callers depend on always
  // getting a snapshot whose `errors` explain why it is empty. Throwing here
  // would turn a transport failure into a crash and lose the provenance.
  let l1: PublicClient;
  try {
    l1 = l1Client();
    snap.l1BlockNumber = (await l1.getBlockNumber()).toString();
  } catch (e) {
    snap.errors.push(
      `L1 unreachable - no parameters could be read: ${String(e).slice(0, 160)}`,
    );
    return snap;
  }

  if (cfg.family === "arbitrum-nitro") {
    const si = cfg.l1Contracts.sequencerInbox;
    if (!si?.address) {
      snap.errors.push("sequencerInbox address missing");
      return snap;
    }
    try {
      const [delayBlocks, futureBlocks, delaySeconds, futureSeconds] =
        await l1.readContract({
          address: si.address,
          abi: SEQUENCER_INBOX_ABI,
          functionName: "maxTimeVariation",
        });
      snap.values.delayBlocks = delayBlocks.toString();
      snap.values.futureBlocks = futureBlocks.toString();
      snap.values.delaySeconds = delaySeconds.toString();
      snap.values.futureSeconds = futureSeconds.toString();
      snap.values.statedForcedBoundSec = delaySeconds.toString();
    } catch (e) {
      // Expected failure mode: BoLD-era SequencerInbox may expose a different
      // signature. Record it rather than guessing a value.
      snap.errors.push(
        `maxTimeVariation() read failed - signature may have changed post-BoLD: ${String(e).slice(0, 160)}`,
      );
    }
    try {
      const read = await l1.readContract({
        address: si.address,
        abi: SEQUENCER_INBOX_ABI,
        functionName: "totalDelayedMessagesRead",
      });
      snap.values.totalDelayedMessagesRead = read.toString();
    } catch (e) {
      snap.errors.push(`totalDelayedMessagesRead() read failed: ${String(e).slice(0, 160)}`);
    }
  }

  if (cfg.family === "op-stack") {
    const portal = cfg.l1Contracts.optimismPortal;
    if (!portal?.address) {
      snap.errors.push(`optimismPortal address UNVERIFIED - ${portal?.source ?? "no source"}`);
    } else {
      try {
        const v = await l1.readContract({
          address: portal.address,
          abi: OPTIMISM_PORTAL_ABI,
          functionName: "version",
        });
        snap.values.portalVersion = v;
      } catch (e) {
        snap.errors.push(`portal version() read failed: ${String(e).slice(0, 160)}`);
      }
    }
    // Sequencing window is NOT on-chain; it comes from the rollup config. Take
    // the source string from the registry rather than asserting one here: a
    // chain whose bound has no located rollup config (Base Sepolia) must be
    // recorded as an error, not handed a borrowed provenance label that would
    // later be persisted as source='rollup-config'.
    if (
      cfg.statedForcedBoundVerification === "UNVERIFIED" ||
      cfg.statedForcedBoundSec === null ||
      cfg.statedForcedBoundSource === null
    ) {
      snap.errors.push(
        "statedForcedBoundSec UNVERIFIED - no first-party rollup config located for this chain; must not be recorded as 'rollup-config'",
      );
    } else {
      snap.values.statedForcedBoundSec = String(cfg.statedForcedBoundSec);
      snap.values.statedForcedBoundSource = cfg.statedForcedBoundSource;
    }
  }

  return snap;
}
