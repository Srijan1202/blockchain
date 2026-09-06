import "dotenv/config";
import { ETH_SEPOLIA, L2S, unverifiedRefs } from "../config/chains.js";
import { l1Client, l2Client, snapshotParams, type ParamSnapshot } from "../core/params.js";

/**
 * Day 1 deliverable.
 *
 * Proves three things before any experiment is written:
 *   1. every RPC endpoint answers and reports the chain ID we expect
 *   2. the L1 contracts we depend on are readable at the addresses we recorded
 *   3. we know exactly which values are still UNVERIFIED
 *
 * Run:  npm run verify
 */

const asJson = process.argv.includes("--json");

interface ChainCheck {
  key: string;
  expectedChainId: number;
  actualChainId: number | null;
  blockNumber: string | null;
  blockTimestamp: string | null;
  ok: boolean;
  error?: string;
}

async function checkL1(): Promise<ChainCheck> {
  const check: ChainCheck = {
    key: ETH_SEPOLIA.key,
    expectedChainId: ETH_SEPOLIA.chainId,
    actualChainId: null,
    blockNumber: null,
    blockTimestamp: null,
    ok: false,
  };
  try {
    const c = l1Client();
    const [id, block] = await Promise.all([c.getChainId(), c.getBlock()]);
    check.actualChainId = id;
    check.blockNumber = block.number?.toString() ?? null;
    check.blockTimestamp = block.timestamp.toString();
    check.ok = id === ETH_SEPOLIA.chainId;
  } catch (e) {
    check.error = String(e).slice(0, 200);
  }
  return check;
}

async function checkL2(key: string): Promise<ChainCheck> {
  const cfg = L2S[key]!;
  const check: ChainCheck = {
    key,
    expectedChainId: cfg.chainId,
    actualChainId: null,
    blockNumber: null,
    blockTimestamp: null,
    ok: false,
  };
  try {
    const c = l2Client(cfg);
    const [id, block] = await Promise.all([c.getChainId(), c.getBlock()]);
    check.actualChainId = id;
    check.blockNumber = block.number?.toString() ?? null;
    check.blockTimestamp = block.timestamp.toString();
    check.ok = id === cfg.chainId;
  } catch (e) {
    check.error = String(e).slice(0, 200);
  }
  return check;
}

async function main(): Promise<void> {
  const chains: ChainCheck[] = [];
  chains.push(await checkL1());
  for (const key of Object.keys(L2S)) {
    chains.push(await checkL2(key));
  }

  const snapshots: ParamSnapshot[] = [];
  for (const key of Object.keys(L2S)) {
    try {
      snapshots.push(await snapshotParams(key));
    } catch (e) {
      snapshots.push({
        chainKey: key,
        family: L2S[key]!.family,
        takenAt: new Date().toISOString(),
        l1BlockNumber: "0",
        values: {},
        errors: [String(e).slice(0, 200)],
      });
    }
  }

  const todo = unverifiedRefs();

  if (asJson) {
    console.log(JSON.stringify({ chains, snapshots, unverified: todo }, null, 2));
    return;
  }

  console.log("\n=== CHAIN CONNECTIVITY ===");
  for (const c of chains) {
    const status = c.ok ? "OK  " : "FAIL";
    const detail = c.ok
      ? `chainId=${c.actualChainId} block=${c.blockNumber} ts=${c.blockTimestamp}`
      : (c.error ?? `expected ${c.expectedChainId}, got ${c.actualChainId}`);
    console.log(`[${status}] ${c.key.padEnd(14)} ${detail}`);
  }

  console.log("\n=== LIVE PROTOCOL PARAMETERS ===");
  for (const s of snapshots) {
    console.log(`\n${s.chainKey} (${s.family}) @ L1 block ${s.l1BlockNumber}`);
    for (const [k, v] of Object.entries(s.values)) {
      console.log(`  ${k} = ${v}`);
    }
    for (const err of s.errors) {
      console.log(`  ! ${err}`);
    }
  }

  console.log("\n=== UNVERIFIED - RESOLVE BEFORE EXPERIMENTS ===");
  if (todo.length === 0) {
    console.log("  none");
  } else {
    for (const t of todo) {
      console.log(`  ${t.chain}.${t.contract} -> ${t.source}`);
    }
  }

  const failed = chains.filter((c) => !c.ok).length;
  console.log(`\nDay-1 exit criterion: ${failed === 0 ? "MET" : `NOT MET (${failed} chain check(s) failing)`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
