import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { L2S, type L2Config } from "../config/chains.js";
import { campaignId, experimentDef, type ExperimentDef } from "../config/experiments.js";
import { childLogger, logger } from "../core/logger.js";
import { l1Client, l2Client, snapshotParams, type ParamSnapshot } from "../core/params.js";
import { assertNotWellKnownTestKey } from "../core/keyguard.js";
import { assertSufficient, formatRequirement, preflightBalances } from "../core/preflight.js";
import { idempotencyKey } from "../core/retry.js";
import type { CostRecord, SubmissionRef, TxSpec } from "../core/types.js";
import { collectCosts } from "../measurement/costs.js";
import { trackRun } from "../measurement/tracker.js";
import { ArbitrumAdapter } from "../protocols/arbitrum/adapter.js";
import { OpStackAdapter } from "../protocols/opstack/adapter.js";
import type { ProtocolAdapter, RunContext } from "../protocols/adapter.js";
import {
  appendExperimentNote,
  experimentExists,
  hasAlreadySubmitted,
  initDb,
  insertExperiment,
  insertParamSnapshot,
  insertRun,
  setExperimentEnded,
  setRunSubmission,
  upsertCosts,
  type ParamSource,
} from "../storage/db.js";
import { toCostRow, u256OrNull } from "../storage/encode.js";

/**
 * Experiment campaign runner (T11).
 *
 *   npm run run -- --experiment B --chain op-sepolia --n 25 [--dry-run]
 *
 * Flow: create the experiments row (git_commit from git rev-parse HEAD) ->
 * snapshot live parameters -> for each i, claim an idempotency key, submit,
 * track, persist costs -> write ended_at.
 */

const HARNESS_VERSION = "0.1.0";

interface Args {
  experiment: string;
  chain: string;
  n: number;
  dryRun: boolean;
  checkOnly: boolean;
  /**
   * Per-stage deadline for the tracker.
   *
   * A CLI flag rather than a per-chain constant on purpose: the timeout is a
   * property of the EXPERIMENTAL SETUP, not of the protocol. Hardcoding one per
   * chain would bake a guess about the latency distribution into the harness
   * from a handful of samples, and I1's reasoning applies - a number that
   * governs measurement should be declared and recorded, not assumed.
   */
  stageTimeoutMs: number;
  suffix?: string;
}

/** 30 minutes. Unchanged default; override per campaign with --stage-timeout-ms. */
const DEFAULT_STAGE_TIMEOUT_MS = 1_800_000;

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const experiment = get("--experiment");
  const chain = get("--chain");
  const nRaw = get("--n");
  if (!experiment || !chain) {
    throw new Error(
      "usage: npm run run -- --experiment B --chain op-sepolia --n 25 " +
        "[--stage-timeout-ms 3600000] [--dry-run | --check-only] [--campaign-suffix S]",
    );
  }
  const n = nRaw === undefined ? 1 : Number(nRaw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer, got ${nRaw}`);
  const timeoutRaw = get("--stage-timeout-ms");
  const stageTimeoutMs = timeoutRaw === undefined ? DEFAULT_STAGE_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(stageTimeoutMs) || stageTimeoutMs <= 0) {
    throw new Error(`--stage-timeout-ms must be a positive integer, got ${timeoutRaw}`);
  }
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check-only");
  if (dryRun && checkOnly) {
    throw new Error(
      "--dry-run and --check-only are contradictory: --dry-run uses a placeholder address, " +
        "--check-only checks the real wallet. Pass one.",
    );
  }
  return { experiment, chain, n, dryRun, checkOnly, stageTimeoutMs, suffix: get("--campaign-suffix") };
}

/** The commit the data was produced by. Reproducibility is a deliverable. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(
      `git rev-parse HEAD failed: ${String(e).slice(0, 120)}. Every campaign must record the commit that produced it.`,
    );
  }
}

/**
 * The timeout must reach the ADAPTER too, not just the tracker.
 *
 * There are two independent deadlines: the tracker races each iterator.next(),
 * and the adapter's own polling loops (waitForL2Tx, waitForL1Receipt,
 * waitForL1Finality) carry their own budget. Threading the flag into only one
 * of them would leave the other at its 30-minute default, so raising the flag
 * would appear to do nothing.
 */
function buildAdapter(cfg: L2Config, stageTimeoutMs: number): ProtocolAdapter {
  if (cfg.family === "arbitrum-nitro") return new ArbitrumAdapter(cfg.key, { stageTimeoutMs });
  if (cfg.family === "op-stack") return new OpStackAdapter(cfg.key, { stageTimeoutMs });
  throw new Error(`No adapter for family ${cfg.family}`);
}

/**
 * Provenance for each snapshot value.
 *
 * Returns null for anything that must NOT be written. Base Sepolia's bound has
 * no located rollup config, so params.ts records an error instead of a value
 * and no row appears here - it must not acquire a source on the way into the
 * database. `statedForcedBoundSource` is provenance metadata about another
 * value, not a value in its own right, so it is skipped too; it is already
 * carried in the source column of the row it describes.
 */
function paramSourceFor(family: string, key: string): ParamSource | null {
  if (key === "statedForcedBoundSource") return null;
  if (key === "statedForcedBoundSec") {
    // Arbitrum's bound IS delaySeconds, read from the contract. The OP Stack's
    // comes from the rollup config and is not on chain.
    return family === "arbitrum-nitro" ? "on-chain" : "rollup-config";
  }
  return "on-chain";
}

function writeParamSnapshot(db: DatabaseHandle, experimentId: string, snap: ParamSnapshot): number {
  let written = 0;
  for (const [key, value] of Object.entries(snap.values)) {
    const source = paramSourceFor(snap.family, key);
    if (source === null) continue;
    insertParamSnapshot(db, {
      snapshot_id: `${experimentId}:${snap.chainKey}:${key}`,
      experiment_id: experimentId,
      chain_key: snap.chainKey,
      taken_at: snap.takenAt,
      l1_block: Number(snap.l1BlockNumber),
      key,
      value,
      source,
    });
    written++;
  }
  for (const err of snap.errors) {
    logger.warn({ chain: snap.chainKey, error: err }, "parameter not recorded - no value or no source");
  }
  return written;
}

function senderAddress(dryRun: boolean): Address {
  const key = process.env.PRIVATE_KEY;
  if (!key || /^0x0+$/.test(key)) {
    if (dryRun) {
      // A dry run must not require a funded key. This address is used only to
      // fill the sender column and as a self-transfer destination.
      return "0x0000000000000000000000000000000000000001";
    }
    throw new Error("PRIVATE_KEY is missing or the all-zero placeholder. A real campaign needs a funded TESTNET key.");
  }
  const address = privateKeyToAccount(key as Hex).address;
  // Fires here so --check-only refuses too: a green wallet report for a key
  // that will be rejected the moment the flag is dropped is the wrong order to
  // find out. The adapters guard again at the last gate before signing.
  assertNotWellKnownTestKey(address, "campaign sender from PRIVATE_KEY");
  return address;
}

/**
 * How the timeout is recorded in the dataset.
 *
 * DECISION - experiments.notes, not param_snapshots. param_snapshots.source is
 * constrained to 'on-chain' | 'rollup-config' | 'docs', and a stage timeout has
 * none of those provenances: it is an operator's choice about the measurement
 * setup, not a value read from the protocol. Recording it there would mean
 * either a false source label or widening the CHECK - the same category error
 * the Base Sepolia bound decision rejected. The campaign record is where an
 * experimental setting belongs.
 */
function stageTimeoutNote(ms: number): string {
  return `stage_timeout_ms=${ms}`;
}

function buildTxSpec(def: ExperimentDef, sender: Address): TxSpec {
  return {
    to: def.to ?? sender, // self-transfer by default, so a campaign does not burn its own funds
    valueWei: def.valueWei,
    data: def.data,
    gasLimit: def.gasLimit,
    kind: def.txKind,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const def = experimentDef(args.experiment);
  const cfg = L2S[args.chain];
  if (!cfg) throw new Error(`Unknown chain ${args.chain}. Known: ${Object.keys(L2S).join(", ")}`);
  if (!def.chains.includes(args.chain)) {
    throw new Error(
      `Experiment ${args.experiment} may not run on ${args.chain}. Allowed: ` +
        `${def.chains.length ? def.chains.join(", ") : "(none - this campaign is devnet-only and no devnet is registered)"}`,
    );
  }

  const experimentId = campaignId(args.experiment, args.chain, args.suffix);
  const db = initDb();
  const adapter = buildAdapter(cfg, args.stageTimeoutMs);
  const sender = senderAddress(args.dryRun && !args.checkOnly);
  const l1 = l1Client();
  const l2 = l2Client(cfg);

  logger.info(
    {
      experiment_id: experimentId,
      chain: args.chain,
      n: args.n,
      dry_run: args.dryRun,
      check_only: args.checkOnly,
      path: def.path,
      stage_timeout_ms: args.stageTimeoutMs,
    },
    args.checkOnly
      ? "balance check only - nothing will be created or sent"
      : args.dryRun
        ? "starting campaign (DRY RUN - nothing will be sent)"
        : "starting campaign",
  );

  // Which indices this invocation would actually submit. Computed BEFORE the
  // preflight so a resumed campaign is not asked to fund work already done, and
  // before any state is created so --check-only can use it too.
  const pendingIndices: number[] = [];
  for (let i = 0; i < args.n; i++) {
    if (!hasAlreadySubmitted(db, idempotencyKey(experimentId, i, def.path, args.chain))) {
      pendingIndices.push(i);
    }
  }
  logger.info(
    { experiment_id: experimentId, requested: args.n, pending: pendingIndices.length, already_submitted: args.n - pendingIndices.length },
    "campaign scope",
  );

  // BALANCE PREFLIGHT - before any submission, scaled to the whole campaign.
  //
  // Skipped under --dry-run, which uses a placeholder address by design.
  // --check-only forces it and then stops, without creating an experiment row,
  // claiming an idempotency key, or sending anything.
  if (!args.dryRun || args.checkOnly) {
    const requirements = await preflightBalances({
      path: def.path,
      cfg,
      tx: buildTxSpec(def, sender),
      sender,
      l1,
      l2,
      runs: pendingIndices.length,
      portal: cfg.l1Contracts.optimismPortal?.address ?? undefined,
      inbox: cfg.l1Contracts.inbox?.address ?? undefined,
    });

    if (args.checkOnly) {
      console.log(`\n=== BALANCE PREFLIGHT: ${experimentId} ===`);
      console.log(`  campaign  ${def.name} (${def.path} path)`);
      console.log(`  runs      ${pendingIndices.length} pending of ${args.n} requested\n`);
      for (const r of requirements) console.log(formatRequirement(r));
      const short = requirements.filter((r) => !r.sufficient);
      console.log(
        short.length === 0
          ? `\nREADY. Nothing was created or submitted.\n`
          : `\nNOT READY: ${short.length} network(s) short. Nothing was created or submitted.\n`,
      );
      db.close();
      process.exitCode = short.length === 0 ? 0 : 1;
      return;
    }

    for (const r of requirements) {
      logger.info(
        {
          network: r.network,
          purpose: r.purpose,
          runs: r.runs,
          per_run_wei: r.perRunBaseWei.toString(),
          have_wei: r.actualWei.toString(),
          need_wei: r.requiredWei.toString(),
          sufficient: r.sufficient,
        },
        "balance preflight",
      );
    }
    assertSufficient(requirements);
  }

  if (experimentExists(db, experimentId)) {
    logger.info({ experiment_id: experimentId }, "campaign already exists - resuming, not restarting");
    // The campaign row already exists, so the note written at creation cannot
    // cover a later invocation that used a different timeout. Record it too, so
    // every value the campaign ran under is recoverable from the dataset.
    appendExperimentNote(db, experimentId, stageTimeoutNote(args.stageTimeoutMs));
  } else {
    insertExperiment(db, {
      experiment_id: experimentId,
      protocol: cfg.family,
      chain_key: args.chain,
      environment: def.environment,
      experiment_type: def.type,
      started_at: new Date().toISOString(),
      git_commit: gitCommit(),
      harness_version: HARNESS_VERSION,
      notes:
        `${def.name}${args.dryRun ? " [DRY RUN]" : ""}. ${def.notes} ` +
        `| ${stageTimeoutNote(args.stageTimeoutMs)}`,
    });
    const snap = await adapter.snapshotParams();
    const written = writeParamSnapshot(db, experimentId, snap);
    logger.info({ experiment_id: experimentId, params_written: written, errors: snap.errors.length }, "parameter snapshot taken");
  }

  let submitted = 0;
  let skipped = 0;

  for (let i = 0; i < args.n; i++) {
    const key = idempotencyKey(experimentId, i, def.path, args.chain);

    // I5: check BEFORE any network call.
    if (hasAlreadySubmitted(db, key)) {
      skipped++;
      logger.info({ experiment_id: experimentId, index: i, idempotency_key: key }, "already submitted - skipping, no network call");
      continue;
    }

    const runId = randomUUID();
    const log = childLogger(runId);
    const ctx: RunContext = {
      runId,
      experimentId,
      chainKey: args.chain,
      environment: def.environment,
      idempotencyKey: key,
      dryRun: args.dryRun,
      logger: log,
    };

    // Claim the key in the database BEFORE submitting. The UNIQUE constraint
    // makes the claim atomic, so a crash between submit and record cannot lead
    // to a second submission on the next run.
    insertRun(db, {
      run_id: runId,
      experiment_id: experimentId,
      idempotency_key: key,
      path: def.path,
      tx_kind: def.txKind,
      sender,
      calldata_bytes: (def.data.length - 2) / 2,
      gas_limit: u256OrNull(def.gasLimit),
      outcome: "pending",
      retry_count: 0,
      submitted_at: new Date().toISOString(),
    });

    const tx = buildTxSpec(def, sender);
    const ref =
      def.path === "forced" ? await adapter.submitForced(tx, ctx) : await adapter.submitNormal(tx, ctx);
    setRunSubmission(db, runId, { l1TxHash: ref.l1TxHash, l1ForceHash: ref.l1ForceHash, l2TxHash: ref.l2TxHash });
    submitted++;

    // Track FIRST, then collect costs.
    //
    // sendTransaction resolves as soon as eth_sendRawTransaction responds - it
    // does not wait for a receipt - so collecting costs here would call
    // getTransactionReceipt on a hash that has only just been broadcast, get
    // TransactionReceiptNotFoundError for every leg, and silently write no
    // costs row while the campaign reported success. Every cost metric would
    // have been empty. The receipts exist once trackRun has followed the
    // lifecycle through to L2 execution.
    const result = await trackRun(db, adapter, ref, ctx, { stageTimeoutMs: args.stageTimeoutMs });

    if (!args.dryRun) {
      const costs = await collectCosts(runId, ref, cfg.family, l1, l2);
      if (costs) {
        upsertCosts(db, toCostRow(costs));
      } else {
        // No receipt for any leg. Absence of observation must not wear the
        // shape of an observation, so no row is written (same principle as
        // param_snapshots refusing a sourceless value).
        log.warn({ outcome: result.outcome }, "no receipts available - writing no costs row");
      }
    }
    log.info(
      {
        experiment_id: experimentId,
        index: i,
        outcome: result.outcome,
        stages: result.stagesObserved.join(","),
        missing: result.stagesMissing.join(","),
      },
      "run complete",
    );

    if (adapter instanceof ArbitrumAdapter) {
      adapter.releaseRun(runId);
      // Pick up any advance made outside this campaign, without ever moving the
      // local nonce backwards past messages still queued in the L1 inbox.
      if (!args.dryRun) {
        const next = await adapter.reconcileNonce(sender);
        log.info({ next_nonce: next }, "reconciled campaign nonce against chain");
      }
    }
  }

  setExperimentEnded(db, experimentId, new Date().toISOString());
  logger.info(
    { experiment_id: experimentId, submitted, skipped, dry_run: args.dryRun },
    "campaign complete",
  );
  db.close();
}

main().catch((e) => {
  logger.error({ error: String(e) }, "campaign failed");
  console.error(e);
  process.exit(1);
});
