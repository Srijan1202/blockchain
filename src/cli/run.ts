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
import { assertSufficient, preflightBalances } from "../core/preflight.js";
import { idempotencyKey } from "../core/retry.js";
import type { CostRecord, SubmissionRef, TxSpec } from "../core/types.js";
import { trackRun } from "../measurement/tracker.js";
import { ArbitrumAdapter } from "../protocols/arbitrum/adapter.js";
import { OpStackAdapter } from "../protocols/opstack/adapter.js";
import type { ProtocolAdapter, RunContext } from "../protocols/adapter.js";
import {
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
  suffix?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const experiment = get("--experiment");
  const chain = get("--chain");
  const nRaw = get("--n");
  if (!experiment || !chain) {
    throw new Error("usage: npm run run -- --experiment B --chain op-sepolia --n 25 [--dry-run] [--campaign-suffix S]");
  }
  const n = nRaw === undefined ? 1 : Number(nRaw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer, got ${nRaw}`);
  return { experiment, chain, n, dryRun: argv.includes("--dry-run"), suffix: get("--campaign-suffix") };
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

function buildAdapter(cfg: L2Config): ProtocolAdapter {
  if (cfg.family === "arbitrum-nitro") return new ArbitrumAdapter(cfg.key);
  if (cfg.family === "op-stack") return new OpStackAdapter(cfg.key);
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

/** Costs from the receipts, where there are receipts to read. */
async function collectCosts(
  runId: string,
  ref: SubmissionRef,
  l1: PublicClient,
  l2: PublicClient,
): Promise<CostRecord | undefined> {
  if (ref.l1TxHash === null && ref.l2TxHash === null) return undefined;
  const costs: CostRecord = {
    runId,
    l1GasUsed: null, l1GasPrice: null, l1FeeWei: null,
    forceGasUsed: null, forceFeeWei: null,
    l2GasUsed: null, l2FeeWei: null, totalFeeWei: null, l1BaseFeeAtSubmit: null,
  };
  // A leg is "expected" when the submission produced a hash for it. Tracking
  // may have timed out with some legs mined and others not; partial costs are
  // legitimate data and are recorded, but the TOTAL is only meaningful when
  // every expected leg was actually observed.
  let expected = 0;
  let observed = 0;
  let total = 0n;

  if (ref.l1TxHash !== null) {
    expected++;
    try {
      const r = await l1.getTransactionReceipt({ hash: ref.l1TxHash });
      costs.l1GasUsed = r.gasUsed;
      costs.l1GasPrice = r.effectiveGasPrice;
      costs.l1FeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.l1FeeWei;
      const block = await l1.getBlock({ blockNumber: r.blockNumber });
      costs.l1BaseFeeAtSubmit = block.baseFeePerGas ?? null;
      observed++;
    } catch { /* not mined; leave null rather than guess */ }
  }
  if (ref.l1ForceHash !== null) {
    expected++;
    try {
      const r = await l1.getTransactionReceipt({ hash: ref.l1ForceHash });
      costs.forceGasUsed = r.gasUsed;
      costs.forceFeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.forceFeeWei;
      observed++;
    } catch { /* not mined */ }
  }
  if (ref.l2TxHash !== null) {
    expected++;
    try {
      const r = await l2.getTransactionReceipt({ hash: ref.l2TxHash });
      costs.l2GasUsed = r.gasUsed;
      costs.l2FeeWei = r.gasUsed * r.effectiveGasPrice;
      total += costs.l2FeeWei;
      observed++;
    } catch { /* not included */ }
  }

  // No receipt anywhere: nothing was observed, so no row (see the write site).
  if (observed === 0) return undefined;

  // Withhold the total on a partial observation rather than reporting a sum
  // that silently omits a leg - M-C4 would be understated and look like a
  // cheaper forced path than it was.
  costs.totalFeeWei = observed === expected ? total : null;
  return costs;
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
  return privateKeyToAccount(key as Hex).address;
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
  const adapter = buildAdapter(cfg);
  const sender = senderAddress(args.dryRun);
  const l1 = l1Client();
  const l2 = l2Client(cfg);

  logger.info(
    { experiment_id: experimentId, chain: args.chain, n: args.n, dry_run: args.dryRun, path: def.path },
    args.dryRun ? "starting campaign (DRY RUN - nothing will be sent)" : "starting campaign",
  );

  if (experimentExists(db, experimentId)) {
    logger.info({ experiment_id: experimentId }, "campaign already exists - resuming, not restarting");
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
      notes: `${def.name}${args.dryRun ? " [DRY RUN]" : ""}. ${def.notes}`,
    });
    const snap = await adapter.snapshotParams();
    const written = writeParamSnapshot(db, experimentId, snap);
    logger.info({ experiment_id: experimentId, params_written: written, errors: snap.errors.length }, "parameter snapshot taken");
  }

  // BALANCE PREFLIGHT - before any submission, and skipped under --dry-run,
  // which uses a placeholder address by design.
  //
  // The requirement depends on the PATH, not just the chain: the forced path on
  // Arbitrum needs Ethereum Sepolia for L1 gas AND Arbitrum Sepolia for the L2
  // execution of the delayed message, while neither A campaign needs Ethereum
  // Sepolia at all. See core/preflight.ts for the traced model.
  if (!args.dryRun) {
    const requirements = await preflightBalances({
      path: def.path,
      cfg,
      tx: buildTxSpec(def, sender),
      sender,
      l1,
      l2,
      portal: cfg.l1Contracts.optimismPortal?.address ?? undefined,
      inbox: cfg.l1Contracts.inbox?.address ?? undefined,
    });
    for (const r of requirements) {
      logger.info(
        {
          network: r.network,
          purpose: r.purpose,
          have_wei: r.actualWei.toString(),
          need_wei: r.requiredWei.toString(),
          sufficient: r.sufficient,
        },
        "balance preflight",
      );
    }
    assertSufficient(requirements);
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
    const result = await trackRun(db, adapter, ref, ctx, {});

    if (!args.dryRun) {
      const costs = await collectCosts(runId, ref, l1, l2);
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
