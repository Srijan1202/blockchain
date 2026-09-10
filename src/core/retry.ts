import type { Logger } from "pino";
import { logger as rootLogger } from "./logger.js";
import type { RunPath } from "./types.js";

/**
 * Typed retry and idempotency (T6).
 *
 * The distinction this module exists to enforce (CLAUDE.md I6):
 *
 *   transport - the request did not get a protocol-level answer. RPC timeout,
 *               connection reset, 5xx, socket hang up. Retrying is correct.
 *   protocol  - the chain answered, and the answer was no. A revert, an
 *               out-of-gas, a rejected transaction. Retrying is WRONG: the
 *               answer will not change, the retry costs real testnet funds,
 *               and it corrupts the sample.
 *
 * A reverting forceInclusion is potentially the single most valuable result in
 * this project. It must surface as an outcome, never be retried into silence
 * and never be swallowed.
 */

export type ErrorClass = "transport" | "protocol";

export interface RetryAttempt {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Delay before the next attempt, in ms. */
  delayMs: number;
  errorClass: ErrorClass;
  error: unknown;
}

export interface RetryOptions {
  /**
   * Decides whether an error is worth retrying. REQUIRED and deliberately not
   * defaulted: the transport/protocol boundary is protocol-specific knowledge,
   * and a generic guess here would silently retry reverts.
   */
  classify: (err: unknown) => ErrorClass;
  /** Total attempts including the first. Default 5. */
  maxAttempts?: number;
  /** First backoff delay in ms. Default 250. */
  baseDelayMs?: number;
  /** Cap on any single delay in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Jitter as a fraction of the delay. Default 0.25. See backoffDelayMs. */
  jitterFactor?: number;
  /** Injectable for deterministic tests. Default Math.random. */
  random?: () => number;
  /** Injectable for tests, so a retry schedule can be asserted without waiting. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryAttempt) => void;
  logger?: Logger;
  /** Label for the log lines. */
  operation?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with bounded jitter.
 *
 * Jitter is a one-sided fraction (delay .. delay*(1+factor)) rather than the
 * usual full jitter, because with a doubling base the smallest possible next
 * delay (2x) still exceeds the largest possible current one (1.25x). The
 * schedule therefore stays strictly increasing while remaining desynchronised
 * across concurrent callers. Delays stop increasing once maxDelayMs is reached.
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number,
  random: () => number,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.round(exponential * (1 + jitterFactor * random()));
}

/**
 * Run `fn`, retrying transport failures only.
 *
 * A protocol failure rethrows immediately, on the first attempt, without a
 * delay. The caller records it as an outcome.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const jitterFactor = opts.jitterFactor ?? 0.25;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.logger ?? rootLogger;
  const operation = opts.operation ?? "operation";

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const errorClass = opts.classify(err);

      if (errorClass === "protocol") {
        // I6. The chain gave an answer and the answer was no. Retrying cannot
        // change it, so surface it now and let the caller record the outcome.
        log.warn(
          { operation, attempt, error_class: errorClass, error: String(err).slice(0, 400) },
          "protocol failure - not retrying, recording as outcome",
        );
        throw err;
      }

      if (attempt === maxAttempts) {
        log.error(
          { operation, attempt, error_class: errorClass, error: String(err).slice(0, 400) },
          "transport failure - attempts exhausted",
        );
        throw err;
      }

      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitterFactor, random);
      log.warn(
        { operation, attempt, delay_ms: delayMs, error_class: errorClass, error: String(err).slice(0, 200) },
        "transport failure - retrying after backoff",
      );
      opts.onRetry?.({ attempt, delayMs, errorClass, error: err });
      await sleep(delayMs);
    }
  }
  /* istanbul ignore next - loop either returns or throws */
  throw lastError;
}

const KEY_SEPARATOR = ":";

/**
 * Deterministic idempotency key for one submission (I5).
 *
 * Same inputs must always produce the same key, because the key is the only
 * thing standing between a retry and a duplicate L1 transaction that costs real
 * funds and corrupts the sample. Components are rejected if they contain the
 * separator: "a:b" and index 1 would otherwise collide with "a" and index "b:1".
 */
export function idempotencyKey(
  experimentId: string,
  index: number,
  path: RunPath,
  chainKey: string,
): string {
  for (const [name, value] of [["experimentId", experimentId], ["chainKey", chainKey]] as const) {
    if (value.includes(KEY_SEPARATOR)) {
      throw new Error(
        `${name} must not contain ${JSON.stringify(KEY_SEPARATOR)}: ${JSON.stringify(value)} ` +
          `would make idempotency keys ambiguous.`,
      );
    }
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`index must be a non-negative integer, got ${index}`);
  }
  return [experimentId, index, path, chainKey].join(KEY_SEPARATOR);
}

/**
 * Has an L1 submission with this key already been recorded?
 *
 * Re-exported from the storage layer rather than reimplemented: the runs table
 * has a UNIQUE constraint on idempotency_key, so the database is the authority
 * on this question and a second implementation could only disagree with it.
 * Check this BEFORE every L1 send.
 */
export { hasAlreadySubmitted } from "../storage/db.js";
