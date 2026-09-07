import type { ClockSource, LifecycleStage } from "./types.js";

/**
 * The three-clock discipline (BLUEPRINT section 11, CLAUDE.md I3), enforced in
 * code rather than by memory.
 *
 * The rule that matters: never claim precision finer than the coarsest clock
 * involved in a calculation. A duration spanning an L1 boundary has ~12s
 * resolution no matter how precisely the other end was measured, and saying
 * otherwise would dress proposer-set block timestamps up as network latency.
 */

/**
 * Nominal resolution of each clock, in seconds. These constants live HERE and
 * nowhere else in the codebase - a second copy is how a mixed-clock metric
 * quietly acquires a precision it never had.
 *
 * CAVEAT worth carrying into the write-up: 0.001 is the nominal resolution of
 * an NTP-synced local clock, but Timestamped carries whole `seconds` as a
 * bigint, so a wall reading is already quantised to 1s in this representation.
 * That only matters for a wall -> wall duration, where this table would claim
 * 0.001s while the data supports at most 1s. No metric in section 9 is
 * wall -> wall (M-L1 ends on an L1 block, so it resolves to 12s), but if one is
 * ever added, this constant is understated for it and must be revisited.
 */
export const CLOCK_RESOLUTION_SECONDS: Readonly<Record<ClockSource, number>> = {
  wall: 0.001,
  l2_block: 2,
  l1_block: 12,
};

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
 * constructed without one; `duration()` below is the only intended way to make
 * one. A Duration that does not declare its own precision cannot exist.
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
}

/**
 * Elapsed time from one stage to another.
 *
 * The result is negative if `to` precedes `from`. That is left as-is on
 * purpose: with proposer-set timestamps and reorgs, a negative duration is a
 * real observation about the data and clamping it to zero would erase the
 * evidence (I6 - a surprising result is data, not an error).
 */
export function duration(
  from: Timestamped,
  to: Timestamped,
  fromStage: LifecycleStage,
  toStage: LifecycleStage,
): Duration {
  const fromResolution = CLOCK_RESOLUTION_SECONDS[from.clockSource];
  const toResolution = CLOCK_RESOLUTION_SECONDS[to.clockSource];

  return {
    seconds: to.seconds - from.seconds,
    mixedClock: from.clockSource !== to.clockSource,
    // Coarser means the LARGER interval: a 12s L1 block bounds the precision of
    // anything measured against it, however finely the other end was read.
    resolutionSeconds: Math.max(fromResolution, toResolution),
    fromStage,
    toStage,
    fromClock: from.clockSource,
    toClock: to.clockSource,
  };
}
