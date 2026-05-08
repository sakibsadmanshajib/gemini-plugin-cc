/**
 * Wire-log capture for ACP traffic.
 *
 * When `ACP_WIRE_LOG=/path/to.jsonl` is set, every JSON-RPC frame the runtime
 * sends or receives is appended as a tagged line to that file. The format
 * matches `tests/integration/fixtures/*.jsonl` exactly so the same file can
 * be replayed via `lib/test-utils/fixture-replayer.mjs`.
 *
 * Format (one record per line):
 *
 *   {"dir": "out", "msg": { ...JSON-RPC frame... }}
 *   {"dir": "in",  "msg": { ...JSON-RPC frame... }}
 *
 * No timestamps are written by default; volatile fields are stripped at
 * fixture-replay time. If callers want timestamps, they can extend `msg`
 * with a `timestamp` field — the replayer will normalize it away.
 *
 * Redaction: the wire log redacts the same credential field paths as the
 * structured logger (see `logger.mjs::REDACTED_PATHS`). For full unredacted
 * capture (local debugging only), set `ACP_WIRE_LOG_RAW=1`. Documented as
 * "do not commit" in `docs/observability.md`.
 */

import fs from "node:fs";

// Each pattern MUST capture the credential field name in group 1 so the
// callback below can quote it back into the replacement. Without a capture
// group, String.prototype.replace passes the match OFFSET (a number) as the
// second callback argument — meaning a `"password"` field would render as
// `"208":"[redacted]"` (or whatever the offset is), corrupting the JSON
// structure of the on-disk wire log. Caught by tests/unit/wire-log.test.mjs.
const REDACT_TOKENS = [
  /"(api_key|apiKey)"\s*:\s*"[^"]*"/g,
  /"(authorization|Authorization)"\s*:\s*"[^"]*"/g,
  /"(token|access_token|refresh_token)"\s*:\s*"[^"]*"/g,
  /"(password)"\s*:\s*"[^"]*"/g
];

/**
 * @typedef {{
 *   record(direction: "in" | "out", message: object): void,
 *   close(): void
 * }} WireLog
 */

/**
 * @param {object} message
 * @param {boolean} raw
 * @returns {string}
 */
function serializeMessage(message, raw) {
  const json = JSON.stringify(message);
  if (raw) return json;
  return REDACT_TOKENS.reduce(
    (acc, pattern) => acc.replace(pattern, (_match, key) => `"${key}":"[redacted]"`),
    json
  );
}

/**
 * Open the wire log if `ACP_WIRE_LOG` is set; otherwise return a no-op.
 * The returned object is safe to use unconditionally — call `record()`
 * for every frame and `close()` on shutdown.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {WireLog}
 */
export function openWireLog(env = process.env) {
  const path = env.ACP_WIRE_LOG;
  if (!path) {
    return {
      record() {},
      close() {}
    };
  }

  const raw = env.ACP_WIRE_LOG_RAW === "1";
  // Open in append mode so multiple processes can log to the same file
  // (broker + companion + worker).
  const fd = fs.openSync(path, "a");

  return {
    record(direction, message) {
      try {
        const body = serializeMessage(message, raw);
        fs.writeSync(fd, `{"dir":"${direction}","msg":${body}}\n`);
      } catch {
        // Wire-log failures must not propagate; logging is best-effort.
      }
    },
    close() {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore.
      }
    }
  };
}
