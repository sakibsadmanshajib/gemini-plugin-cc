/**
 * Structured logger built on pino. **stderr-only** (the broker pattern reserves
 * stdout for JSON-RPC; logs leaking to stdout would corrupt the wire — this
 * invariant is pinned by the `Stdio Discipline` requirement in the
 * gemini-plugin-baseline spec).
 *
 * Usage:
 *
 *   import { logger } from "../lib/logger.mjs";
 *   logger.info({ jobId, sessionId }, "starting prompt");
 *   const child = logger.child({ component: "broker" });
 *
 * Redaction applies to known credential field paths so log output is
 * safe to ship to a centralized aggregator. The opt-out is per-call:
 * pass `{ rawAuth: 1 }` as a child binding and the redaction skips that
 * scope (intended for local debugging only).
 */

import pino from "pino";

// The credential field-name list MUST stay in sync with
// `lib/middleware/redaction.mjs` DEFAULT_FIELD_NAMES and
// `lib/wire-log.mjs` REDACT_TOKENS — those three are the project's
// independent redaction layers, and a name missing from one but
// present in another opens a window where a bypassing payload leaks
// through that layer.
const REDACTED_PATHS = [
  "*.api_key",
  "*.apiKey",
  "*.authorization",
  "*.Authorization",
  "*.password",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.secret",
  "params.api_key",
  "params.apiKey",
  "params.authorization",
  "credentials.*"
];

/**
 * Resolve log level from env. Honors `LOG_LEVEL` (pino-standard: trace, debug,
 * info, warn, error, fatal). Defaults to `info`. `DEBUG=1` is treated as a
 * shorthand for `LOG_LEVEL=debug`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveLevel(env = process.env) {
  const explicit = env.LOG_LEVEL?.toLowerCase();
  if (explicit) return explicit;
  if (env.DEBUG) return "debug";
  return "info";
}

/**
 * Build the root logger. Always writes to stderr (fd 2) to keep stdout
 * available as the JSON-RPC wire.
 */
function createRootLogger() {
  return pino(
    {
      level: resolveLevel(),
      base: undefined, // Don't auto-include hostname/pid; child bindings are explicit.
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: REDACTED_PATHS,
        censor: "[redacted]"
      }
    },
    pino.destination(2)
  );
}

/**
 * The root logger. Singleton per process.
 *
 * @type {import("pino").Logger}
 */
export const logger = createRootLogger();

/**
 * Test-only reset hook. Re-creates the root logger (useful when tests change
 * env vars and want the level to reflow).
 */
export function _resetLoggerForTests() {
  // pino's level is mutable on the existing logger; cheaper than rebuilding.
  logger.level = resolveLevel();
}
