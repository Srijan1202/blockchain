import { L2S } from "../config/chains.js";
import type { ClockSource, LifecycleStage } from "./types.js";

/**
 * The three-clock discipline (BLUEPRINT section 11, CLAUDE.md I3), enforced in
 * code rather than by memory.
 *
 * The rule that matters: never claim precision finer than the coarsest clock
 * involved in a calculation. A duration spanning an L1 boundary has ~12s
 * resolution no matter how precisely the other end was measured, and saying
 * otherwise would dress proposer-set block timestamps up as network latency.
 *
 * L2 resolution is PER CHAIN, not global. Arbitrum Sepolia produces blocks at
 * ~0.25s and the OP chains at 2s; a single l2_block constant would overstate
 * Arbitrum's precision by 8x or understate OP's, and the error would be
 * invisible in the output. The value comes from blockTimeSec in the chain
 * registry, which is the one place chain facts are recorded.
 */

/** Nominal resolution of an NTP-synced local clock, in seconds. */
export const WALL_RESOLUTION_SECONDS = 0.001;

/**
 * L1 block resolution, in seconds. Global because every rollup here settles to
 * the same Ethereum L1, whose ~12s slot time is shared and proposer-set.
 */
export const L1_BLOCK_RESOLUTION_SECONDS = 12;

export type ClockResolutions = Readonly<Record<ClockSource, number>>;

/**
 * Resolutions for one L2.
 *
 * CAVEAT worth carrying into the write-up: wall is listed at its nominal
 * 0.001s, but Timestamped carries whole `seconds` as a bigint, so a wall
 * reading is already quantised to 1s in this representation. That only matters
 * for a wall -> wall duration, and no section 9 metric is wall -> wall (M-L1
 * ends on an L1 block, so it resolves to 12s). If one is ever added, this
 * constant is understated for it and must be revisited.
 */
export function clockResolutions(l2BlockTimeSec: number): ClockResolutions {
  return {
    wall: WALL_RESOLUTION_SECONDS,
    l1_block: L1_BLOCK_RESOLUTION_SECONDS,
    l2_block: l2BlockTimeSec,
  };
}

/** A point in time, carrying the clock it was read from. */
export interface Timestamped {
  clockSource: ClockSource;
  /** Seconds. bigint, never a float - see I8. */
  seconds: bigint;
}

/**
 * An elapsed time between two lifecycle stages.
 *
 * `resolutionSeconds` is required, so the compiler rejects any Duration
 * constructed without one. A Duration that does not declare its own precision
 * cannot exist.
 */
export interface Duration {
  readonly seconds: bigint;
  /** True when the two endpoints were read from different clocks. */
  readonly mixedClock: boolean;
  /** The COARSER of the two clocks. Precision must never be claimed below it. */
  readonly resolutionSeconds: number;
  readonly fromStage: LifecycleStage;
  readonly toStage: LifecycleStage;
  readonly fromClock: ClockSource;
  readonly toClock: ClockSource;
  /** Which chain's L2 resolution was applied. Makes the number self-describing. */
  readonly chainKey: string;
}

/**
 * Elapsed time between two stages, against an explicit resolution table.
 *
 * Prefer clockFor(chainKey).duration(...) at call sites; this form exists so
 * the resolutions can be supplied directly without a registry lookup.
 *
 * The result is negative if `to` precedes `from`. That is left as-is on
 * purpose: with proposer-set timestamps and reorgs, a negative duration is a
 * real observation about the data and clamping it to zero would erase the
 * evidence (I6 - a surprising result is data, not an error).
 */
export function durationWith(
  chainKey: string,
  resolutions: ClockResolutions,
  from: Timestamped,
  to: Timestamped,
  fromStage: LifecycleStage,
  toStage: LifecycleStage,
): Duration {
  return {
    seconds: to.seconds - from.seconds,
    mixedClock: from.clockSource !== to.clockSource,
    // Coarser means the LARGER interval: a 12s L1 block bounds the precision of
    // anything measured against it, however finely the other end was read.
    resolutionSeconds: Math.max(resolutions[from.clockSource], resolutions[to.clockSource]),
    fromStage,
    toStage,
    fromClock: from.clockSource,
    toClock: to.clockSource,
    chainKey,
  };
}

/** A clock bound to one chain's resolutions. */
export interface ChainClock {
  readonly chainKey: string;
  readonly resolutions: ClockResolutions;
  duration(
    from: Timestamped,
    to: Timestamped,
    fromStage: LifecycleStage,
    toStage: LifecycleStage,
  ): Duration;
}

/**
 * Clock for one registered L2, taking its block time from the chain registry.
 * Throws on an unknown chain rather than falling back to a default: a silently
 * assumed block time is exactly the kind of invented constant I1 forbids.
 */
export function clockFor(chainKey: string): ChainClock {
  const cfg = L2S[chainKey];
  if (!cfg) {
    throw new Error(
      `Unknown chain ${chainKey}: cannot determine L2 clock resolution. ` +
        `Register it in config/chains.ts with a sourced blockTimeSec.`,
    );
  }
  const resolutions = clockResolutions(cfg.blockTimeSec);
  return {
    chainKey,
    resolutions,
    duration: (from, to, fromStage, toStage) =>
      durationWith(chainKey, resolutions, from, to, fromStage, toStage),
  };
}
