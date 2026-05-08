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
 * safe to ship to a centralized aggregator. There is currently NO
 * opt-out — earlier docs mentioned a `{ rawAuth: 1 }` child-binding
 * escape hatch but it was never implemented. For local debugging
 * with un-redacted output, set `ACP_WIRE_LOG_RAW=1` (the wire-log's
 * documented opt-out) on the wire log, or temporarily edit
 * REDACTED_PATHS in this file.
 */

import pino from "pino";

// The credential field-name list MUST stay in sync with
// `lib/middleware/redaction.mjs` DEFAULT_FIELD_NAMES and
// `lib/wire-log.mjs` REDACT_TOKENS — those three are the project's
// independent redaction layers, and a name missing from one but
// present in another opens a window where a bypassing payload leaks
// through that layer.
//
// Each credential field gets TWO entries: a bare path (top-level,
// e.g. `api_key`) AND `*.<name>` (one-level-nested, e.g.
// `request.api_key`). pino's path syntax doesn't recurse on `*.`
// — that pattern matches exactly one level above. Without the
// bare-path entry, a `logger.info({api_key: "sk-..."})` call
// would write the credential verbatim. Caught by
// tests/unit/logger.test.mjs redaction-wiring case.
/**
 * Exported so tests + downstream consumers can pin the policy shape.
 * If you change this list, update `lib/middleware/redaction.mjs`
 * `DEFAULT_FIELD_NAMES` and `lib/wire-log.mjs` `REDACT_TOKENS` in
 * lockstep — those three layers must agree.
 */
export const REDACTED_PATHS = [
  // Top-level (most common usage pattern: logger.info({api_key, ...})).
  "api_key",
  "apiKey",
  "authorization",
  "Authorization",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  // One level nested (e.g. logger.info({request: {api_key}})).
  "*.api_key",
  "*.apiKey",
  "*.authorization",
  "*.Authorization",
  "*.password",
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.secret",
  // Specific deeper paths kept from the original list — these
  // cover the JSON-RPC wire shape (params: { api_key, ... }) which
  // shows up frequently in middleware/runner logs.
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
