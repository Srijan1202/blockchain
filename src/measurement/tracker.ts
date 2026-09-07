import type { Database as DatabaseHandle } from "better-sqlite3";
import { clockFor, type Duration } from "../core/clock.js";
import type { CostRecord, LifecycleEvent, LifecycleStage, Outcome, SubmissionRef } from "../core/types.js";
import type { ProtocolAdapter, RunContext } from "../protocols/adapter.js";
import {
  getLifecycleEvent,
  insertLifecycleEvent,
  insertLifecycleRevision,
  setRunOutcome,
  updateLifecycleEvent,
  upsertCosts,
} from "../storage/db.js";
import { toCostRow, toLifecycleEventRow } from "../storage/encode.js";

/**
 * Lifecycle tracker (T9).
 *
 * Consumes adapter.track(), persists each stage, computes durations through the
 * chain's own clock, and finalises only after L1 finality.
 *
 * REORG DECISION (see migrations/002_lifecycle_revisions.sql). lifecycle_events
 * holds ONE current row per (run_id, stage) - the UNIQUE constraint from T4 is
 * kept, because it is what makes a run impossible to double-count. A correction
 * therefore cannot be appended. Instead, persistEvent copies the prior row into
 * lifecycle_event_revisions BEFORE overwriting it, so the original observation
 * survives. Updating in place without that copy was rejected: a reorg that
 * moved a measurement is itself data, and quietly keeping only the corrected
 * value would erase the evidence that anything moved.
 *
 * TIMEOUTS. A stage that does not arrive within the deadline writes
 * outcome = 'timeout' and stops. It is never retried - the tracker observes,
 * and re-submitting would corrupt the sample (I5) - and it is never thrown, so
 * a slow stage cannot take down a campaign. A timeout is a recorded result.
 */

export interface TrackerOptions {
  /** Per-stage deadline. The clock restarts each time a stage arrives. */
  stageTimeoutMs?: number;
  /**
   * Re-read a block to check it still says what we recorded, before finalising.
   * Returns the block's current timestamp, or null if the block is gone.
   * Omitted means no re-verification is possible and rows stay unfinalised.
   */
  reverify?: (event: LifecycleEvent) => Promise<{ blockNumber: bigint; blockTimestamp: bigint } | null>;
  /**
   * Costs for this run, if observed. When omitted NO costs row is written -
   * absence means "not observed", never "measured as zero". See the decision
   * recorded at the write site below.
   */
  costs?: CostRecord;
  now?: () => number;
}

export interface TrackResult {
  runId: string;
  outcome: Outcome;
  stagesObserved: LifecycleStage[];
  /** Stages the protocol supports that never arrived. Absence is data, not error. */
  stagesMissing: LifecycleStage[];
  durations: Record<string, Duration>;
  revisions: number;
  timedOutAfterStage: LifecycleStage | null;
}

const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000;

/**
 * Consume an adapter's event stream for one run and persist it.
 *
 * Returns the outcome rather than throwing it: 'success' when the stream
 * completed, 'timeout' when a stage did not arrive in time.
 */
export async function trackRun(
  db: DatabaseHandle,
  adapter: ProtocolAdapter,
  submission: SubmissionRef,
  ctx: RunContext,
  opts: TrackerOptions = {},
): Promise<TrackResult> {
  const stageTimeoutMs = opts.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const log = ctx.logger;

  const observed = new Map<LifecycleStage, LifecycleEvent>();
  let revisions = 0;
  // Tracked separately from lastStage on purpose: a run that times out BEFORE
  // its first stage has still timed out, and inferring the outcome from
  // "did we see a stage" would silently record that as 'pending'.
  let timedOut = false;
  let timedOutAfterStage: LifecycleStage | null = null;
  let lastStage: LifecycleStage | null = null;

  const iterator = adapter.track(submission, ctx)[Symbol.asyncIterator]();

  for (;;) {
    const started = now();
    const next = await raceWithTimeout(iterator.next(), stageTimeoutMs);

    if (next === TIMED_OUT) {
      timedOut = true;
      timedOutAfterStage = lastStage;
      log.warn(
        { run_id: ctx.runId, after_stage: lastStage, waited_ms: now() - started },
        "stage timed out - recording outcome 'timeout', not retrying",
      );
      // Best effort: stop the adapter's polling loop.
      await iterator.return?.(undefined);
      break;
    }
    if (next.done === true) break;

    const event = next.value;
    if (!adapter.supportedStages.has(event.stage)) {
      // An adapter must never emit a stage it does not claim to support.
      log.error(
        { run_id: ctx.runId, stage: event.stage },
        "adapter emitted an unsupported stage - refusing to persist",
      );
      continue;
    }

    revisions += persistEvent(db, event, ctx, "reorg");
    observed.set(event.stage, event);
    lastStage = event.stage;
    log.info(
      {
        run_id: ctx.runId,
        stage: event.stage,
        clock_source: event.clockSource,
        block_number: event.blockNumber?.toString() ?? null,
      },
      "stage observed",
    );
  }

  // Finality, per BLUEPRINT section 11 rule 5: re-verify before marking final.
  if (opts.reverify) {
    for (const event of observed.values()) {
      if (event.blockNumber === null) continue;
      const current = await opts.reverify(event);
      if (current === null) {
        log.warn({ run_id: ctx.runId, stage: event.stage }, "block vanished on re-verification - leaving unfinalised");
        continue;
      }
      const moved =
        current.blockNumber !== event.blockNumber || current.blockTimestamp !== event.blockTimestamp;
      const corrected: LifecycleEvent = moved
        ? { ...event, blockNumber: current.blockNumber, blockTimestamp: current.blockTimestamp, finalized: true }
        : { ...event, finalized: true };
      if (moved) {
        log.warn(
          {
            run_id: ctx.runId,
            stage: event.stage,
            was_block: event.blockNumber.toString(),
            now_block: current.blockNumber.toString(),
          },
          "reorg detected - superseding the prior observation, which is preserved in lifecycle_event_revisions",
        );
      }
      revisions += persistEvent(db, corrected, ctx, "reorg");
      observed.set(event.stage, corrected);
    }
  }

  // A timeout is a recorded result, never thrown. A stream that ended without
  // producing anything is left 'pending' rather than called a timeout.
  const outcome: Outcome = timedOut ? "timeout" : observed.size === 0 ? "pending" : "success";
  setRunOutcome(db, ctx.runId, outcome, null);

  // COSTS DECISION - write a row only when costs were actually observed.
  //
  // An all-null row was rejected for the same reason param_snapshots refuses a
  // sourceless value: absence of observation must not wear the shape of an
  // observation. A row of nulls is indistinguishable at analysis time from a
  // dry run, from a real run whose receipt never arrived, and from a genuine
  // measurement of zero - and SUM/AVG over that column would silently include
  // runs that were never measured.
  //
  // The alternative, a row plus an "observed" flag, was rejected as duplicated
  // state: the runs row already answers why costs are missing. A dry run has no
  // tx hashes, and outcome distinguishes 'timeout' from 'success'. Absence in
  // costs plus the runs row is complete, and a LEFT JOIN yields NULL either way
  // without anyone having to remember a flag.
  if (opts.costs) {
    upsertCosts(db, toCostRow(opts.costs));
  } else {
    log.debug({ run_id: ctx.runId }, "no costs observed for this run - writing no costs row");
  }

  const durations = computeDurations(ctx.chainKey, observed);
  const stagesMissing = [...adapter.supportedStages].filter((s) => !observed.has(s)).sort();

  return {
    runId: ctx.runId,
    outcome,
    stagesObserved: [...observed.keys()].sort(),
    stagesMissing,
    durations,
    revisions,
    timedOutAfterStage,
  };
}

/**
 * Insert or supersede one stage. Returns 1 if a prior observation was revised.
 *
 * The prior row is copied into lifecycle_event_revisions before the update, so
 * no observation is ever discarded.
 */
export function persistEvent(
  db: DatabaseHandle,
  event: LifecycleEvent,
  ctx: RunContext,
  reason: "reorg" | "recheck",
): number {
  const row = toLifecycleEventRow(event);
  const prior = getLifecycleEvent(db, event.runId, event.stage);

  if (prior === undefined) {
    insertLifecycleEvent(db, row);
    return 0;
  }

  const unchanged =
    (prior.block_number ?? null) === (row.block_number ?? null) &&
    (prior.block_timestamp ?? null) === (row.block_timestamp ?? null) &&
    (prior.finalized ?? 0) === (row.finalized ?? 0);
  if (unchanged) return 0;

  insertLifecycleRevision(db, prior, reason, new Date().toISOString());
  updateLifecycleEvent(db, row);
  ctx.logger.info(
    { run_id: event.runId, stage: event.stage, reason },
    "superseded a prior observation; the original is preserved in lifecycle_event_revisions",
  );
  return 1;
}

/**
 * Durations for the metrics whose endpoints are both present.
 *
 * Computed through clockFor(chainKey), so each carries that chain's own L2
 * resolution rather than a global constant, and declares mixedClock where the
 * endpoints came from different clocks.
 */
export function computeDurations(
  chainKey: string,
  observed: Map<LifecycleStage, LifecycleEvent>,
): Record<string, Duration> {
  const clock = clockFor(chainKey);
  const out: Record<string, Duration> = {};
  const pairs: Array<[string, LifecycleStage, LifecycleStage]> = [
    ["M_L1", "S2", "S3"], // submit -> L1 inclusion (mixed clock by construction)
    ["M_L2", "S3", "S7"], // L1 inclusion -> L2 appearance (the clean comparable)
    ["M_L4", "S1", "S8"], // normal-path baseline
  ];
  for (const [metric, fromStage, toStage] of pairs) {
    const from = observed.get(fromStage);
    const to = observed.get(toStage);
    if (!from || !to || from.blockTimestamp === null || to.blockTimestamp === null) continue;
    out[metric] = clock.duration(
      { clockSource: from.clockSource, seconds: from.blockTimestamp },
      { clockSource: to.clockSource, seconds: to.blockTimestamp },
      fromStage,
      toStage,
    );
  }
  return out;
}

const TIMED_OUT = Symbol("timed-out");

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
