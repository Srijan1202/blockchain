import type { Logger } from "pino";
import type { ProtocolFamily } from "../config/chains.js";
import type { ParamSnapshot } from "../core/params.js";
import type {
  ChainLayer,
  ClockSource,
  Confidence,
  Environment,
  LifecycleEvent,
  LifecycleStage,
  RunPath,
  SubmissionRef,
  TxSpec,
} from "../core/types.js";

/**
 * The extension point (T7). Adding a rollup means implementing this interface.
 *
 * If a new protocol needs changes beyond its own adapter directory plus one
 * line of the chain registry, the abstraction is wrong and that should be said
 * out loud rather than worked around.
 */

/** Everything an adapter needs about the run it is executing. */
export interface RunContext {
  runId: string;
  experimentId: string;
  chainKey: string;
  /**
   * Which environment this run belongs to. Adapters must use it for labelling,
   * never to relax a claim: only E1 can demonstrate censorship (I4).
   */
  environment: Environment;
  /** Checked before every L1 send (I5). */
  idempotencyKey: string;
  /** When true, build and validate everything but send nothing. */
  dryRun: boolean;
  logger: Logger;
}

/** How one protocol marks one lifecycle stage. */
export interface StageSpec {
  meaning: string;
  chainLayer: ChainLayer;
  clockSource: ClockSource;
  /**
   * 'inferred' where the stage is computed rather than witnessed. S5 is the
   * only such stage: force eligibility is derived from the live delaySeconds,
   * not observed on chain, and must never be recorded as 'observed'.
   */
  confidence: Confidence;
  /** The on-chain evidence marking this stage, where there is one. */
  evidence: string | null;
}

export type StageMap = Readonly<Partial<Record<LifecycleStage, StageSpec>>>;

/**
 * BLUEPRINT section 14 stage model for Arbitrum Nitro.
 *
 * S5 and S6 are PRESENT here: Arbitrum has a force-eligibility stage and a
 * user-invoked force action, and both are exercised on the E1 devnet with a
 * shortened delaySeconds. See the supportedStages note below for why they are
 * nonetheless expected to be empty on public testnet.
 */
export const ARBITRUM_STAGES: StageMap = {
  S1: { meaning: "transaction generated", chainLayer: "L2", clockSource: "wall", confidence: "observed", evidence: null },
  S2: { meaning: "submitted to path", chainLayer: "L1", clockSource: "wall", confidence: "observed", evidence: null },
  S3: { meaning: "L1 inclusion of submission", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "L1 receipt" },
  S4: { meaning: "protocol queue entry", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "InboxMessageDelivered" },
  S5: { meaning: "force eligibility", chainLayer: "L1", clockSource: "l1_block", confidence: "inferred", evidence: "computed from live delaySeconds" },
  S6: { meaning: "force action", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "SequencerInbox.forceInclusion" },
  S7: { meaning: "L2 appearance", chainLayer: "L2", clockSource: "l2_block", confidence: "observed", evidence: "L2 block" },
  S8: { meaning: "L2 execution", chainLayer: "L2", clockSource: "l2_block", confidence: "observed", evidence: "L2 receipt" },
  S9: { meaning: "L1 finality", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "L1 finalized" },
};

/**
 * Stage model for the OP Stack.
 *
 * S5 and S6 are ABSENT, and their absence is the finding. Derivation must
 * include a deposit, so there is no eligibility condition to wait for and no
 * force call to make. These are not stages the OP Stack fails to reach; they
 * are stages it does not have.
 */
export const OPSTACK_STAGES: StageMap = {
  S1: { meaning: "transaction generated", chainLayer: "L2", clockSource: "wall", confidence: "observed", evidence: null },
  S2: { meaning: "submitted to path", chainLayer: "L1", clockSource: "wall", confidence: "observed", evidence: null },
  S3: { meaning: "L1 inclusion of submission", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "L1 receipt" },
  S4: { meaning: "protocol queue entry", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "TransactionDeposited" },
  S7: { meaning: "L2 appearance", chainLayer: "L2", clockSource: "l2_block", confidence: "observed", evidence: "type 0x7E deposit tx in L2 block" },
  S8: { meaning: "L2 execution", chainLayer: "L2", clockSource: "l2_block", confidence: "observed", evidence: "L2 receipt" },
  S9: { meaning: "L1 finality", chainLayer: "L1", clockSource: "l1_block", confidence: "observed", evidence: "L1 finalized" },
};

export const STAGE_MAPS: Readonly<Partial<Record<ProtocolFamily, StageMap>>> = {
  "arbitrum-nitro": ARBITRUM_STAGES,
  "op-stack": OPSTACK_STAGES,
};

function stagesOf(map: StageMap): ReadonlySet<LifecycleStage> {
  return new Set(Object.keys(map) as LifecycleStage[]);
}

export const ARBITRUM_SUPPORTED_STAGES = stagesOf(ARBITRUM_STAGES);
export const OPSTACK_SUPPORTED_STAGES = stagesOf(OPSTACK_STAGES);

/**
 * Stages applicable to the NORMAL path, for either protocol.
 *
 * The normal path submits straight to the sequencer RPC, so S3 (L1 inclusion of
 * the submission), S4 (protocol queue entry), S5 and S6 do not exist on it -
 * there is no L1 transaction to observe. Only generation, submission, and the
 * two L2 stages apply.
 *
 * S9 (L1 finality) is DELIBERATELY ABSENT and this is a decision, not an
 * oversight. A normal-path transaction does reach L1 eventually, inside a
 * sequencer batch, but observing that means identifying and following the batch
 * that carries it - SequencerBatchDelivered on Arbitrum, the batcher's blob
 * submission on the OP Stack. That is a different measurement, it is not
 * required by any metric in BLUEPRINT section 9, and M-L4 (normal-path latency)
 * is S1 -> S8. Claiming S9 here without doing that work would be fabricating a
 * stage; omitting it silently would make it ambiguous. So it is excluded from
 * the path set, which makes "no S9 row on a normal run" read as NOT APPLICABLE.
 */
export const NORMAL_PATH_STAGES: ReadonlySet<LifecycleStage> = new Set<LifecycleStage>([
  "S1",
  "S2",
  "S7",
  "S8",
]);

export interface ProtocolAdapter {
  readonly chainKey: string;
  readonly family: ProtocolFamily;

  /** Baseline: submit through the sequencer RPC. */
  submitNormal(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef>;

  /** Forced path: submit through the L1 mechanism. */
  submitForced(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef>;

  /**
   * Protocol-specific completion action.
   *
   * Arbitrum: SequencerInbox.forceInclusion once the delay has elapsed.
   * OP Stack: returns null - inclusion is automatic.
   *
   * DO NOT "FIX" THE NULL. It is not an unimplemented stub. It is the encoded
   * form of the paper's central asymmetry and is directly the M-U1 metric, the
   * number of user-initiated L1 transactions: 2 for Arbitrum, 1 for the OP
   * Stack. Inventing an OP Stack force call would fabricate a mechanism the
   * protocol does not have and destroy the measurement.
   */
  completeForced(ref: SubmissionRef, ctx: RunContext): Promise<SubmissionRef | null>;

  /** Emit lifecycle events as they become observable. */
  track(ref: SubmissionRef, ctx: RunContext): AsyncIterable<LifecycleEvent>;

  /** Live protocol parameters, for the snapshot table. */
  snapshotParams(): Promise<ParamSnapshot>;

  /**
   * Stages this protocol can produce. Never fake a stage it lacks.
   *
   * DECISION - this expresses PROTOCOL CAPABILITY, not environment
   * reachability. Two different facts would otherwise collapse into one
   * ambiguous zero:
   *
   *   OP Stack, S5/S6   - excluded here. The protocol has no force-eligibility
   *                       stage and no force call. Zero rows means NOT
   *                       APPLICABLE.
   *   Arbitrum, S5/S6   - included here, and empty on public testnet. The
   *                       protocol has both stages and reaches them on the E1
   *                       devnet, but per BLUEPRINT section 20.1 a healthy
   *                       sequencer reads the delayed message long before the
   *                       24h window opens, so E2 can never reach them. Zero
   *                       rows means APPLICABLE BUT NOT REACHED HERE.
   *
   * At analysis time the pair (stage in supportedStages, row count) therefore
   * distinguishes "the mechanism does not exist" from "the mechanism exists and
   * was not exercised" - which is precisely the distinction the paper turns on.
   * Reachability is a property of the environment and belongs to the run, not
   * to the adapter.
   */
  readonly supportedStages: ReadonlySet<LifecycleStage>;

  /**
   * Stages applicable to one PATH of this protocol.
   *
   * DECISION - supportedStages stays protocol-level, and this is added
   * alongside it rather than replacing it. Together they give a three-way
   * reading of an absent row, where two of the three were previously
   * indistinguishable:
   *
   *   stage not in supportedStages        -> the PROTOCOL has no such stage
   *                                          (OP Stack S5/S6: not applicable)
   *   in supportedStages, not in this set -> the protocol has it, but this PATH
   *                                          does not use it (S3/S4 on the
   *                                          normal path: not applicable here)
   *   in this set, but no row             -> applicable and NOT OBSERVED
   *
   * Collapsing the first two would reintroduce exactly the ambiguity T7 removed
   * for S5/S6, one level down. The tracker reports stagesMissing against this
   * set, so "missing" always means the third case.
   */
  stagesForPath(path: RunPath): ReadonlySet<LifecycleStage>;
}
