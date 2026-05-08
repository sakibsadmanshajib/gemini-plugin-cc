/**
 * Smoke + behavior tests for `bin/artagon-stats.mjs`.
 *
 * Coverage:
 *   - argv: --version, --help, unknown flag, malformed --since
 *   - Empty log: friendly message, exit 0
 *   - Populated log: summary lines render, exit 0 when under budget
 *   - --budget over limit: text mode prints OVER BUDGET, exits 3
 *   - --budget-usd over limit: same, with $ message
 *   - --json output includes summary + recent + budget block
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const BIN = path.join(ROOT, "bin/artagon-stats.mjs");

/** @type {string} */
let tmpDir;
/** @type {string} */
let costLog;
/** @type {NodeJS.ProcessEnv} */
let env;

beforeEach(() => {
  // mkdtempSync atomically creates a unique 0o700 directory — fixes
  // CodeQL js/insecure-temporary-file vs the prior path.join with a
  // hex suffix, which is predictable and race-able.
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `stats-bin-${crypto.randomBytes(4).toString("hex")}-`)
  );
  costLog = path.join(tmpDir, "cost.jsonl");
  env = { ...process.env, ARTAGON_COST_LOG: costLog };
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** @param {string[]} args */
function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    timeout: 10000,
    env
  });
}

/** @param {any[]} records */
function seedLog(records) {
  fs.writeFileSync(costLog, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("bin/artagon-stats.mjs — argv", () => {
  test("--version prints PKG.version", () => {
    const r = runBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help prints usage including --budget", () => {
    const r = runBin(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/--budget/);
    expect(r.stdout.toString()).toMatch(/--budget-usd/);
  });

  test("unknown flag → exit 2", () => {
    const r = runBin(["--bogus"]);
    expect(r.status).toBe(2);
    // commander format: "error: unknown option '--bogus'"
    expect(r.stderr.toString()).toMatch(/unknown option '--bogus'/);
  });

  test("invalid --since → exit 2", () => {
    const r = runBin(["--since", "not-a-date"]);
    expect(r.status).toBe(2);
    // commander surfaces our InvalidArgumentError("must be a valid ISO 8601 timestamp")
    expect(r.stderr.toString()).toMatch(/--since/);
    expect(r.stderr.toString()).toMatch(/ISO 8601/);
  });

  test("invalid --budget (non-numeric) → exit 2", () => {
    const r = runBin(["--budget", "abc"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--budget/);
    expect(r.stderr.toString()).toMatch(/positive number/);
  });

  test("invalid --budget-usd (zero) → exit 2", () => {
    const r = runBin(["--budget-usd", "0"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--budget-usd/);
    expect(r.stderr.toString()).toMatch(/positive number/);
  });
});

describe("bin/artagon-stats.mjs — empty log", () => {
  test("Friendly message + exit 0 when log doesn't exist", () => {
    const r = runBin([]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/No cost records/);
  });

  test("--budget on empty log: under-budget, exit 0", () => {
    const r = runBin(["--budget", "1000"]);
    expect(r.status).toBe(0);
  });
});

describe("bin/artagon-stats.mjs — populated log", () => {
  const sampleRecord = {
    timestamp: "2026-05-08T19:00:00.000Z",
    backend: "claude",
    model: "claude-sonnet-4-6",
    promptChars: 42,
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    durationMs: 1000,
    reason: "stop",
    ok: true
  };

  test("Summary text rendered with totals + cost", () => {
    seedLog([sampleRecord]);
    const r = runBin([]);
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    expect(out).toMatch(/Total turns: 1/);
    expect(out).toMatch(/Total tokens: 1,500/);
    expect(out).toMatch(/Estimated cost: \$/);
    expect(out).toMatch(/claude/);
  });

  test("text mode (no --recent): defaults to last 5 records (matches README)", () => {
    // Seed 7 records — the default of 5 should clip to the most recent 5.
    const records = Array.from({ length: 7 }, (_, i) => ({
      ...sampleRecord,
      timestamp: `2026-05-0${i + 1}T00:00:00.000Z`
    }));
    seedLog(records);
    const r = runBin([]);
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    // Header reflects the chosen size.
    expect(out).toMatch(/Recent \(5\):/);
    // Most recent 5 are 2026-05-03 .. 2026-05-07 (mtime descending).
    expect(out).toMatch(/2026-05-07/);
    expect(out).toMatch(/2026-05-03/);
    // The two oldest don't appear in the Recent block.
    const recentSection = out.slice(out.indexOf("Recent ("));
    expect(recentSection).not.toMatch(/2026-05-01/);
    expect(recentSection).not.toMatch(/2026-05-02/);
  });

  test("--json (no --recent): does NOT include recent block (default opt-in only)", () => {
    seedLog([sampleRecord]);
    const r = runBin(["--json"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout.toString());
    // Defaulting --recent for text mode must NOT bleed into JSON —
    // tooling parsing the output should see exactly { summary } here.
    expect(body).not.toHaveProperty("recent");
  });

  test("--recent 0: explicit zero suppresses the default Recent block", () => {
    seedLog([sampleRecord]);
    const r = runBin(["--recent", "0"]);
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    expect(out).not.toMatch(/Recent \(/);
  });

  test("--json includes summary + budget block when --budget set", () => {
    seedLog([sampleRecord]);
    const r = runBin(["--json", "--budget", "10000"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout.toString());
    expect(body.summary.total_tokens).toBe(1500);
    expect(body.budget).toEqual({
      tokens: 10000,
      usd: null,
      over: false,
      message: null
    });
  });

  test("--budget over limit → exit 3 + OVER BUDGET on stderr", () => {
    seedLog([sampleRecord]);
    const r = runBin(["--budget", "1000"]);
    expect(r.status).toBe(3);
    expect(r.stdout.toString()).toMatch(/Total tokens: 1,500/);
    expect(r.stderr.toString()).toMatch(/OVER BUDGET: tokens 1,500/);
  });

  test("--budget-usd over limit → exit 3 with $ message", () => {
    seedLog([sampleRecord]);
    // 1500 sonnet tokens (1000 input @ $3/M + 500 output @ $15/M)
    //   = $0.003 + $0.0075 = $0.0105
    // --budget-usd 0.001 ⇒ over.
    const r = runBin(["--budget-usd", "0.001"]);
    expect(r.status).toBe(3);
    expect(r.stderr.toString()).toMatch(/OVER BUDGET: estimated \$/);
  });

  test("--budget under limit → exit 0", () => {
    seedLog([sampleRecord]);
    const r = runBin(["--budget", "10000"]);
    expect(r.status).toBe(0);
  });

  test("--recent N includes most recent rows in text output", () => {
    const records = [
      { ...sampleRecord, timestamp: "2026-05-01T00:00:00.000Z" },
      { ...sampleRecord, timestamp: "2026-05-02T00:00:00.000Z" },
      { ...sampleRecord, timestamp: "2026-05-03T00:00:00.000Z" }
    ];
    seedLog(records);
    const r = runBin(["--recent", "2"]);
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    // Slice from "Recent (" onward — the Window line above also contains
    // dates and would false-match a "no older row" assertion.
    const recentSection = out.slice(out.indexOf("Recent ("));
    expect(recentSection).toMatch(/Recent \(2\):/);
    expect(recentSection).toMatch(/2026-05-03/);
    expect(recentSection).toMatch(/2026-05-02/);
    // Older row excluded from the Recent block specifically.
    expect(recentSection).not.toMatch(/2026-05-01/);
  });
});
