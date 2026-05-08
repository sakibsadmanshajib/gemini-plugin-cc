/**
 * Unit tests for `lib/wire-log.mjs`.
 *
 * Covers:
 *   - openWireLog with ACP_WIRE_LOG unset → no-op (record + close are
 *     safe to call, no file is created)
 *   - openWireLog with ACP_WIRE_LOG=<path> → appends one JSONL row
 *     per record() call in {"dir":"<in|out>","msg":<frame>}\n format
 *   - Redaction (default): api_key, apiKey, authorization,
 *     Authorization, token, access_token, refresh_token, password
 *     are scrubbed to "[redacted]" before write
 *   - Redaction respects ACP_WIRE_LOG_RAW=1 (full unredacted capture)
 *   - record() on a closed log doesn't throw (best-effort semantics)
 *
 * The redaction matters for compliance — a wire-log is exactly the
 * kind of artifact that ends up shipped to a centralized aggregator
 * or attached to a bug report. A regression that lets an api_key
 * through is a credential leak.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { openWireLog } from "#lib/wire-log.mjs";

/** @type {string} */
let tmpDir;
/** @type {string} */
let logPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-log-test-"));
  logPath = path.join(tmpDir, "wire.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("openWireLog with ACP_WIRE_LOG unset → no-op (no file created)", () => {
  const log = openWireLog({});
  expect(typeof log.record).toBe("function");
  expect(typeof log.close).toBe("function");
  log.record("out", { method: "test", params: { x: 1 } });
  log.close();
  expect(fs.existsSync(logPath)).toBe(false);
});

test("openWireLog writes one line per record(), correct envelope", () => {
  const log = openWireLog({ ACP_WIRE_LOG: logPath });
  log.record("out", { jsonrpc: "2.0", id: 1, method: "ping" });
  log.record("in", { jsonrpc: "2.0", id: 1, result: { pong: true } });
  log.close();

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);

  const a = JSON.parse(lines[0]);
  expect(a.dir).toBe("out");
  expect(a.msg).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });

  const b = JSON.parse(lines[1]);
  expect(b.dir).toBe("in");
  expect(b.msg).toEqual({ jsonrpc: "2.0", id: 1, result: { pong: true } });
});

test("default redaction: scrubs all 9 sensitive field names", () => {
  // Field names MUST match the union of redaction layers:
  //   lib/middleware/redaction.mjs DEFAULT_FIELD_NAMES (the primary)
  //   lib/wire-log.mjs REDACT_TOKENS (this test target)
  //   lib/logger.mjs REDACTED_PATHS (the structured logger)
  // A name missing from any of these three opens a leak window for
  // payloads that bypass that layer.
  const log = openWireLog({ ACP_WIRE_LOG: logPath });
  log.record("out", {
    method: "test",
    params: {
      api_key: "sk-leak-1",
      apiKey: "sk-leak-2",
      authorization: "Bearer leak-3",
      Authorization: "Bearer leak-4",
      token: "t-leak-5",
      access_token: "at-leak-6",
      refresh_token: "rt-leak-7",
      password: "p-leak-8",
      secret: "s-leak-9",
      safe: "kept"
    }
  });
  log.close();

  const raw = fs.readFileSync(logPath, "utf8");
  // Every secret value should be gone from the on-disk text.
  for (const leak of [
    "sk-leak-1",
    "sk-leak-2",
    "Bearer leak-3",
    "Bearer leak-4",
    "t-leak-5",
    "at-leak-6",
    "rt-leak-7",
    "p-leak-8",
    "s-leak-9"
  ]) {
    expect(raw).not.toContain(leak);
  }
  // The "[redacted]" replacement appears for the credential fields.
  expect(raw).toContain('"api_key":"[redacted]"');
  expect(raw).toContain('"apiKey":"[redacted]"');
  expect(raw).toContain('"authorization":"[redacted]"');
  expect(raw).toContain('"Authorization":"[redacted]"');
  expect(raw).toContain('"token":"[redacted]"');
  expect(raw).toContain('"access_token":"[redacted]"');
  expect(raw).toContain('"refresh_token":"[redacted]"');
  expect(raw).toContain('"password":"[redacted]"');
  expect(raw).toContain('"secret":"[redacted]"');
  // Non-credential fields are preserved.
  expect(raw).toContain('"safe":"kept"');
});

test("ACP_WIRE_LOG_RAW=1 disables redaction (local debug opt-in)", () => {
  const log = openWireLog({
    ACP_WIRE_LOG: logPath,
    ACP_WIRE_LOG_RAW: "1"
  });
  log.record("out", {
    params: { api_key: "sk-debug-keep-me" }
  });
  log.close();

  // Raw mode keeps the credential value verbatim. This is documented
  // as local-debug-only — the test verifies the opt-in works, not
  // that it's a good idea to use it in prod.
  const raw = fs.readFileSync(logPath, "utf8");
  expect(raw).toContain("sk-debug-keep-me");
  expect(raw).not.toContain("[redacted]");
});

test("ACP_WIRE_LOG_RAW=anything-else stays redacted (only '1' opts in)", () => {
  // Defensive: a sloppy `ACP_WIRE_LOG_RAW=true` shouldn't accidentally
  // disable redaction. Only the exact string "1" is the opt-in.
  const log = openWireLog({
    ACP_WIRE_LOG: logPath,
    ACP_WIRE_LOG_RAW: "true"
  });
  log.record("out", { params: { api_key: "should-be-redacted" } });
  log.close();

  const raw = fs.readFileSync(logPath, "utf8");
  expect(raw).not.toContain("should-be-redacted");
  expect(raw).toContain('"api_key":"[redacted]"');
});

test("close() then record(): silent best-effort, no throw", () => {
  const log = openWireLog({ ACP_WIRE_LOG: logPath });
  log.record("out", { ok: true });
  log.close();
  // After close, the fd is invalid. record() catches internally —
  // wire-log failures must never propagate to the caller.
  expect(() => log.record("out", { after: "close" })).not.toThrow();
});
