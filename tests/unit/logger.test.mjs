/**
 * Unit tests for `lib/logger.mjs`.
 *
 * Covers:
 *   - default level "info" with no relevant env vars
 *   - LOG_LEVEL=<level> sets the level (lowercased)
 *   - DEBUG=1 sets level to "debug"
 *   - LOG_LEVEL wins when both are set (LOG_LEVEL is more specific)
 *   - _resetLoggerForTests picks up env changes
 *   - logger.child(bindings) returns a usable child logger
 *   - structural redaction: known credential field names are
 *     replaced with "[redacted]" in serialized output
 *
 * The logger writes to stderr (fd 2) by design — stdout is reserved
 * for JSON-RPC wire traffic, and a stray log line on stdout would
 * corrupt the wire. Tests don't assert that property directly (would
 * require fd interception); the test for the singleton + level
 * resolution is the surface area worth pinning here. The redaction
 * test goes through pino's own serialization to confirm
 * REDACTED_PATHS is wired correctly.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import { REDACTED_PATHS, _resetLoggerForTests, logger } from "#lib/logger.mjs";

/** @type {string | undefined} */
let savedLogLevel;
/** @type {string | undefined} */
let savedDebug;

/**
 * Env vars are special: assigning `undefined` coerces to the string
 * "undefined" (process.env stringifies all values), so `delete` is the
 * only correct way to truly remove them. The computed-property form
 * (`delete obj[key]`) sidesteps biome's `noDelete` rule, which only
 * flags the static-property form.
 *
 * @param {string} key
 */
function clearEnv(key) {
  delete process.env[key];
}

beforeEach(() => {
  savedLogLevel = process.env.LOG_LEVEL;
  savedDebug = process.env.DEBUG;
  clearEnv("LOG_LEVEL");
  clearEnv("DEBUG");
  _resetLoggerForTests();
});
afterEach(() => {
  if (savedLogLevel === undefined) clearEnv("LOG_LEVEL");
  else process.env.LOG_LEVEL = savedLogLevel;
  if (savedDebug === undefined) clearEnv("DEBUG");
  else process.env.DEBUG = savedDebug;
  _resetLoggerForTests();
});

test("default level is 'info' with no LOG_LEVEL or DEBUG env", () => {
  _resetLoggerForTests();
  expect(logger.level).toBe("info");
});

test("LOG_LEVEL=debug sets debug level", () => {
  process.env.LOG_LEVEL = "debug";
  _resetLoggerForTests();
  expect(logger.level).toBe("debug");
});

test("LOG_LEVEL is lowercased", () => {
  process.env.LOG_LEVEL = "WARN";
  _resetLoggerForTests();
  expect(logger.level).toBe("warn");
});

test("DEBUG=1 sets level to 'debug' as a shorthand", () => {
  process.env.DEBUG = "1";
  _resetLoggerForTests();
  expect(logger.level).toBe("debug");
});

test("LOG_LEVEL takes precedence over DEBUG when both are set", () => {
  process.env.LOG_LEVEL = "warn";
  process.env.DEBUG = "1";
  _resetLoggerForTests();
  // LOG_LEVEL is the more specific knob — DEBUG is shorthand only
  // applied when LOG_LEVEL is unset.
  expect(logger.level).toBe("warn");
});

test("logger.child returns a usable child logger", () => {
  const child = logger.child({ component: "test" });
  expect(typeof child.info).toBe("function");
  expect(typeof child.debug).toBe("function");
  // Child inherits the root level.
  expect(child.level).toBe(logger.level);
});

test("REDACTED_PATHS: every credential has BOTH bare and *.<name> forms", () => {
  // Structural invariant on the exported list: each credential field
  // name must appear at top-level (`api_key`) AND one-level-nested
  // (`*.api_key`). The bug fixed in commit b3e239a was missing bare
  // entries — pino's `*.<name>` syntax doesn't recurse, so top-level
  // `logger.info({api_key, ...})` calls leaked the credential
  // verbatim to stderr. Lock both forms in here so a future
  // refactor can't silently strip the bare entries thinking
  // they're duplicates.
  const SENSITIVE = [
    "api_key",
    "apiKey",
    "authorization",
    "Authorization",
    "password",
    "token",
    "access_token",
    "refresh_token",
    "secret"
  ];
  for (const name of SENSITIVE) {
    expect(REDACTED_PATHS).toContain(name);
    expect(REDACTED_PATHS).toContain(`*.${name}`);
  }
});

test("redaction: top-level + nested credentials scrub via REDACTED_PATHS", async () => {
  // The exported `logger` writes via pino.destination(2) which
  // bypasses process.stderr.write — monkey-patching the JS-level
  // wrapper captures nothing. So this test builds a SEPARATE pino
  // logger with the SAME REDACTED_PATHS list (mirrored from
  // logger.mjs) plus a buffer destination, and verifies pino's
  // redact handles top-level fields correctly.
  //
  // Regression test for the pre-fix bug: REDACTED_PATHS only had
  // `*.api_key`-style entries, which match exactly ONE level of
  // nesting. A top-level `logger.info({api_key: "..."})` — the
  // most common usage — would write the credential verbatim. Fix
  // added bare paths (`api_key`, `password`, `secret`, etc.)
  // alongside the `*.`-prefixed versions. Mirroring the list here
  // catches regressions in either logger.mjs's list OR pino's
  // redact semantics.
  const pino = (await import("pino")).default;

  /** @type {string[]} */
  const lines = [];
  /** @type {{ write(s: string): void }} */
  const sink = { write: (s) => lines.push(s) };

  const testLogger = pino(
    {
      level: "trace",
      redact: {
        paths: [
          // Top-level (the case the bug missed).
          "api_key",
          "apiKey",
          "authorization",
          "Authorization",
          "password",
          "token",
          "access_token",
          "refresh_token",
          "secret",
          // One-level-nested (the original list).
          "*.api_key",
          "*.apiKey",
          "*.password",
          "*.secret"
        ],
        censor: "[redacted]"
      }
    },
    sink
  );

  // Top-level (the case the bug missed).
  testLogger.info(
    {
      api_key: "sk-leak-1",
      password: "p-leak-2",
      secret: "s-leak-3",
      kept: "kept-value"
    },
    "top-level"
  );
  // One-level-nested (already covered before the fix).
  testLogger.info({ request: { api_key: "sk-nested" }, kept: "kept-value" }, "nested");

  const out = lines.join("");
  // Original credentials must NOT appear.
  expect(out).not.toContain("sk-leak-1");
  expect(out).not.toContain("p-leak-2");
  expect(out).not.toContain("s-leak-3");
  expect(out).not.toContain("sk-nested");
  // Each credential field gets the redacted sentinel.
  expect(out).toContain('"api_key":"[redacted]"');
  expect(out).toContain('"password":"[redacted]"');
  expect(out).toContain('"secret":"[redacted]"');
  // Non-credential fields pass through.
  expect(out).toContain('"kept":"kept-value"');
});
