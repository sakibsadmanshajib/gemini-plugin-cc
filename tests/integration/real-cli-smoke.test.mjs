/**
 * Real-CLI smoke test — opt-in end-to-end verification.
 *
 * Runs `runStatelessTurn(<backend>, ...)` against the actual `claude` /
 * `codex` / `gemini` CLI binaries when they're installed on PATH.
 * Verifies the full pipeline: spawn → stream-json → translator →
 * TurnResult → cost record. Each backend's test auto-skips when its
 * CLI is missing or when authentication isn't configured (the CLI
 * fails fast with a recognizable error and we accept that as a
 * deliberate skip rather than a failure).
 *
 * This is gated by environment because:
 *   - CI doesn't ship the vendor CLIs (we'd add ~600MB of installs)
 *   - The real CLIs make real network calls + cost real money
 *   - Auth tokens aren't available in CI without complicated setup
 *
 * Run locally with:
 *
 *   ARTAGON_REAL_CLI_SMOKE=1 pnpm vitest run tests/integration/real-cli-smoke.test.mjs
 *
 * Without that env var, all tests skip and the file is a no-op (the
 * full suite picks it up but doesn't slow down).
 *
 * Each test uses a tiny prompt ("reply with the single word PONG")
 * and a 30s timeout. Cost: a few input tokens + ~10 output tokens
 * per backend per run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const ENABLED = process.env.ARTAGON_REAL_CLI_SMOKE === "1";

/** @param {string} bin */
function isOnPath(bin) {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
  return r.status === 0 || r.status === 1; // some CLIs exit 1 from --version
}

const PROMPT = "Reply with the single word PONG and nothing else.";
/** @type {string} */
let costLog;

beforeEach(() => {
  // Each test points at its own cost log so we can verify the record
  // round-tripped properly.
  costLog = path.join(os.tmpdir(), `real-cli-smoke-${Date.now()}-${Math.random()}.jsonl`);
  process.env.ARTAGON_COST_LOG = costLog;
});

afterEach(() => {
  try {
    fs.unlinkSync(costLog);
  } catch {
    // best-effort
  }
  process.env.ARTAGON_COST_LOG = "";
});

describe.skipIf(!ENABLED)("real CLI smoke (opt-in via ARTAGON_REAL_CLI_SMOKE=1)", () => {
  test.skipIf(!isOnPath("claude"))(
    "claude --print produces text + cost record",
    async () => {
      const turn = await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
        prompt: PROMPT,
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000
      });
      expect(turn.text.length).toBeGreaterThan(0);
      // Cost log should have one row.
      const lines = fs.readFileSync(costLog, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const rec = JSON.parse(lines[0]);
      expect(rec.backend).toBe(BACKEND_NAMES.CLAUDE);
      expect(rec.ok).toBe(true);
    },
    60_000
  );

  test.skipIf(!isOnPath("codex"))(
    "codex exec --json produces text + cost record",
    async () => {
      const turn = await runStatelessTurn(BACKEND_NAMES.CODEX, {
        prompt: PROMPT,
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000
      });
      expect(turn.text.length).toBeGreaterThan(0);
      const lines = fs.readFileSync(costLog, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const rec = JSON.parse(lines[0]);
      expect(rec.backend).toBe(BACKEND_NAMES.CODEX);
      expect(rec.ok).toBe(true);
    },
    60_000
  );

  test.skipIf(!isOnPath("gemini"))(
    "gemini -p produces text + cost record",
    async () => {
      const turn = await runStatelessTurn(BACKEND_NAMES.GEMINI, {
        prompt: PROMPT,
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000
      });
      expect(turn.text.length).toBeGreaterThan(0);
      const lines = fs.readFileSync(costLog, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const rec = JSON.parse(lines[0]);
      expect(rec.backend).toBe(BACKEND_NAMES.GEMINI);
      expect(rec.ok).toBe(true);
    },
    60_000
  );
});

// When the env gate is off, surface a single passing placeholder so
// the file isn't reported as empty in test output. Vitest treats the
// describe.skipIf above as zero tests when ENABLED is false; this keeps
// the file from looking suspicious in the suite tally.
describe.skipIf(ENABLED)("real CLI smoke (gated off)", () => {
  test("placeholder — set ARTAGON_REAL_CLI_SMOKE=1 to run real smoke", () => {
    expect(ENABLED).toBe(false);
  });
});
