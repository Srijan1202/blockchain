import "dotenv/config";
import type { Hex } from "viem";
import { L2S, type L2Config } from "../config/chains.js";
import { childLogger, logger } from "../core/logger.js";
import { l1Client, l2Client } from "../core/params.js";
import type { LifecycleEvent, LifecycleStage, SubmissionRef } from "../core/types.js";
import { collectCosts } from "../measurement/costs.js";
import { trackRun } from "../measurement/tracker.js";
import { ArbitrumAdapter } from "../protocols/arbitrum/adapter.js";
import { OpStackAdapter } from "../protocols/opstack/adapter.js";
import type { ProtocolAdapter, RunContext } from "../protocols/adapter.js";
import {
  initDb,
  lifecycleEventsForRun,
  resumableRuns,
  setExperimentEnded,
  upsertCosts,
  type ResumableRun,
} from "../storage/db.js";
import { fromLifecycleEventRow, toCostRow } from "../storage/encode.js";

/**
 * Resume an interrupted run.
 *
 *   npm run resume -- --experiment B-arb-sepolia [--run <run_id>]
 *
 * A campaign can be interrupted mid-flight - a laptop sleeping, an RPC dropping,
 * Ctrl-C - leaving a run whose transaction is on chain but whose lifecycle
 * stops partway, with outcome 'pending' or 'timeout' and no costs row. That
 * will happen again during the pilot, which is why this is a command rather
 * than a one-off script: it needs to be versioned, reproducible from
 * REPRODUCE.md, and identical every time it is used.
 *
 * WHAT IT DOES NOT DO. It never submits anything. Everything is reconstructed
 * from the hashes already recorded against the run, read back from chain. The
 * idempotency key stays claimed and is never reused, so there is no path here
 * that could double-submit (I5).
 *
 * It reuses the adapter's own track() rather than reimplementing the lifecycle.
 * track() replays the stream from the beginning; stages already recorded are
 * seeded into the tracker and skipped rather than rewritten, so an interruption
 * is not mistaken for a correction (see TrackerOptions.preObserved).
 */

interface Args {
  experiment?: string;
  run?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const args = { experiment: get("--experiment"), run: get("--run") };
  if (!args.experiment && !args.run) {
    throw new Error("usage: npm run resume -- --experiment <experiment_id> [--run <run_id>]");
  }
  return args;
}

function buildAdapter(cfg: L2Config): ProtocolAdapter {
  if (cfg.family === "arbitrum-nitro") return new ArbitrumAdapter(cfg.key);
  if (cfg.family === "op-stack") return new OpStackAdapter(cfg.key);
  throw new Error(`No adapter for family ${cfg.family}`);
}

/**
 * Rebuild the SubmissionRef from what was recorded, never from anything typed
 * in by hand. S1 and S2 are wall-clock stages, so their stored block_timestamp
 * carries the original submission time; using `now` instead would silently
 * rewrite the run's start and corrupt M-L1 and M-L4.
 */
function refFromRecord(run: ResumableRun, stored: Map<LifecycleStage, LifecycleEvent>): SubmissionRef {
  const wall = (stage: LifecycleStage): string => {
    const e = stored.get(stage);
    if (!e || e.blockTimestamp === null) {
      throw new Error(
        `cannot resume ${run.run_id}: stage ${stage} has no recorded timestamp, so the original ` +
          `submission time is unknown and would have to be invented`,
      );
    }
    return new Date(Number(e.blockTimestamp) * 1000).toISOString();
  };
  return {
    runId: run.run_id,
    chainKey: run.chain_key,
    path: run.path,
    l1TxHash: (run.l1_tx_hash as Hex | null) ?? null,
    l1ForceHash: (run.l1_force_hash as Hex | null) ?? null,
    l2TxHash: (run.l2_tx_hash as Hex | null) ?? null,
    generatedAt: wall("S1"),
    submittedAt: wall("S2"),
  };
}

async function resumeOne(
  db: ReturnType<typeof initDb>,
  run: ResumableRun,
): Promise<void> {
  const cfg = L2S[run.chain_key];
  if (!cfg) throw new Error(`unknown chain ${run.chain_key} for run ${run.run_id}`);
  const log = childLogger(run.run_id);

  const storedRows = lifecycleEventsForRun(db, run.run_id);
  const stored = new Map<LifecycleStage, LifecycleEvent>();
  for (const row of storedRows) stored.set(row.stage, fromLifecycleEventRow(row));

  const ref = refFromRecord(run, stored);
  const adapter = buildAdapter(cfg);

  log.info(
    {
      experiment_id: run.experiment_id,
      chain: run.chain_key,
      path: run.path,
      outcome_before: run.outcome,
      stages_recorded: [...stored.keys()].sort().join(","),
      l1_tx_hash: ref.l1TxHash,
      l2_tx_hash: ref.l2TxHash,
    },
    "resuming from chain - nothing will be submitted",
  );

  if (ref.l1TxHash === null && ref.l2TxHash === null) {
    log.error({}, "no hashes recorded - nothing to reconstruct from");
    return;
  }

  const ctx: RunContext = {
    runId: run.run_id,
    experimentId: run.experiment_id,
    chainKey: run.chain_key,
    environment: "testnet",
    idempotencyKey: "(resume - key already claimed, never reused)",
    // Emphatically not a dry run: this reads live chain state. It simply has
    // nothing to send, because the transaction was sent by the original run.
    dryRun: false,
    logger: log,
  };

  const result = await trackRun(db, adapter, ref, ctx, { preObserved: stored });

  log.info(
    {
      outcome: result.outcome,
      observed: result.stagesObserved.join(","),
      missing: result.stagesMissing.join(",") || "(none)",
      revisions: result.revisions,
    },
    "resume tracking complete",
  );

  // Costs AFTER tracking, per the ordering fixed in e6871d9: the receipts do
  // not exist until the lifecycle does.
  const l1 = l1Client();
  const l2 = l2Client(cfg);
  const costs = await collectCosts(run.run_id, ref, cfg.family, l1, l2);
  if (costs) {
    upsertCosts(db, toCostRow(costs));
    log.info(
      {
        l2_fee_wei: costs.l2FeeWei?.toString() ?? null,
        op_l1_data_fee_wei: costs.opL1DataFeeWei?.toString() ?? null,
        arb_l1_gas_allocation: costs.arbL1GasAllocation?.toString() ?? null,
        total_fee_wei: costs.totalFeeWei?.toString() ?? null,
      },
      "costs collected",
    );
  } else {
    log.warn({}, "no receipts available - writing no costs row");
  }

  for (const [metric, d] of Object.entries(result.durations)) {
    log.info(
      {
        metric,
        seconds: d.seconds.toString(),
        mixed_clock: d.mixedClock,
        resolution_sec: d.resolutionSeconds,
        from: d.fromStage,
        to: d.toStage,
      },
      "duration",
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = initDb();

  let runs = resumableRuns(db, args.experiment);
  if (args.run) runs = runs.filter((r) => r.run_id === args.run);

  if (runs.length === 0) {
    logger.info(
      { experiment_id: args.experiment ?? "(any)", run_id: args.run ?? "(any)" },
      "nothing to resume: no run with outcome 'pending' or 'timeout' and a recorded hash",
    );
    db.close();
    return;
  }

  logger.info({ count: runs.length }, "resumable runs found");
  for (const run of runs) {
    await resumeOne(db, run);
  }

  // Close out any campaign whose runs are now all finished.
  const experiments = [...new Set(runs.map((r) => r.experiment_id))];
  for (const experimentId of experiments) {
    const stillOpen = resumableRuns(db, experimentId).length;
    if (stillOpen === 0) {
      setExperimentEnded(db, experimentId, new Date().toISOString());
      logger.info({ experiment_id: experimentId }, "campaign complete - ended_at set");
    } else {
      logger.info({ experiment_id: experimentId, still_open: stillOpen }, "campaign still has open runs");
    }
  }
  db.close();
}

main().catch((e) => {
  logger.error({ error: String(e) }, "resume failed");
  console.error(e);
  process.exit(1);
});
