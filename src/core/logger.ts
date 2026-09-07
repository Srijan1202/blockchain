import pino from "pino";
import type { Logger } from "pino";

/**
 * Structured logging (T6).
 *
 * JSON on stdout, one object per line, so a campaign's logs can be replayed and
 * joined to the database afterwards. No pretty-printing transport: the log is a
 * research artifact first and something to read second.
 */

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // drop pid/hostname - noise that varies between reruns
});

/**
 * A logger that stamps run_id on every line it emits.
 *
 * BLUEPRINT section 14 requires a run_id on every log line: without it, the
 * interleaved output of a campaign cannot be attributed to individual runs
 * after the fact, and a single anomalous run is the thing most worth finding.
 */
export function childLogger(runId: string): Logger {
  return logger.child({ run_id: runId });
}
