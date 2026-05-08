/**
 * Unit tests for lib/cost/aggregate.mjs.
 *
 * Coverage:
 *   - readCostRecords: parses JSONL, filters by since/until, skips
 *     malformed lines, returns [] when log missing
 *   - summarizeCostRecords: per-backend totals, ok vs failed, time window
 *   - recentCostRecords: chronological sort + limit
 *   - formatCostSummaryText: empty + populated rendering
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  formatCostSummaryText,
  readCostRecords,
  recentCostRecords,
  summarizeCostRecords
} from "#lib/cost/aggregate.mjs";

/** @type {string} */
let tmpDir;
/** @type {string} */
let logPath;
/** @type {NodeJS.ProcessEnv} */
let env;

function seedLog(/** @type {any[]} */ records) {
  fs.writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cost-aggregate-${crypto.randomBytes(4).toString("hex")}-`)
  );
  logPath = path.join(tmpDir, "cost.jsonl");
  env = { ...process.env, ARTAGON_COST_LOG: logPath };
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("readCostRecords", () => {
  test("Returns [] when log file missing", () => {
    expect(readCostRecords({ env })).toEqual([]);
  });

  test("Returns [] when log file empty", () => {
    fs.writeFileSync(logPath, "");
    expect(readCostRecords({ env })).toEqual([]);
  });

  test("Parses valid JSONL records", () => {
    seedLog([
      {
        timestamp: "2026-01-01T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        promptChars: 10,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        durationMs: 1000,
        reason: "stop",
        ok: true
      }
    ]);
    const records = readCostRecords({ env });
    expect(records).toHaveLength(1);
    expect(records[0].backend).toBe(BACKEND_NAMES.CLAUDE);
  });

  test("Skips malformed JSON lines", () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          backend: BACKEND_NAMES.CLAUDE,
          ok: true
        }),
        "not-json",
        JSON.stringify({
          timestamp: "2026-01-02T00:00:00Z",
          backend: BACKEND_NAMES.CODEX,
          ok: true
        })
      ].join("\n") + "\n"
    );
    const records = readCostRecords({ env });
    expect(records).toHaveLength(2);
  });

  test("Skips records without timestamp or backend", () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ backend: BACKEND_NAMES.CLAUDE, ok: true }), // missing timestamp
        JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", ok: true }), // missing backend
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          backend: BACKEND_NAMES.GEMINI,
          ok: true
        }) // valid
      ].join("\n") + "\n"
    );
    const records = readCostRecords({ env });
    expect(records).toHaveLength(1);
  });

  test("since filter excludes earlier records", () => {
    seedLog([
      {
        timestamp: "2026-01-01T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        ok: true
      },
      {
        timestamp: "2026-01-15T00:00:00Z",
        backend: BACKEND_NAMES.CODEX,
        ok: true
      },
      {
        timestamp: "2026-02-01T00:00:00Z",
        backend: BACKEND_NAMES.GEMINI,
        ok: true
      }
    ]);
    const records = readCostRecords({
      env,
      since: new Date("2026-01-10T00:00:00Z")
    });
    expect(records.map((r) => r.backend)).toEqual([BACKEND_NAMES.CODEX, BACKEND_NAMES.GEMINI]);
  });

  test("until filter excludes later records", () => {
    seedLog([
      {
        timestamp: "2026-01-01T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        ok: true
      },
      {
        timestamp: "2026-01-15T00:00:00Z",
        backend: BACKEND_NAMES.CODEX,
        ok: true
      },
      {
        timestamp: "2026-02-01T00:00:00Z",
        backend: BACKEND_NAMES.GEMINI,
        ok: true
      }
    ]);
    const records = readCostRecords({
      env,
      until: new Date("2026-01-20T00:00:00Z")
    });
    expect(records.map((r) => r.backend)).toEqual([BACKEND_NAMES.CLAUDE, BACKEND_NAMES.CODEX]);
  });
});

describe("summarizeCostRecords", () => {
  test("Empty input: zero summary", () => {
    const s = summarizeCostRecords([]);
    expect(s).toEqual({
      total_turns: 0,
      ok_turns: 0,
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_duration_ms: 0,
      per_backend: {},
      first_seen: null,
      last_seen: null
    });
  });

  test("Aggregates per-backend totals + global totals + window", () => {
    const records = /** @type {any[]} */ ([
      {
        timestamp: "2026-01-01T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        durationMs: 1000,
        ok: true
      },
      {
        timestamp: "2026-01-02T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300
        },
        durationMs: 2000,
        ok: false
      },
      {
        timestamp: "2026-01-03T00:00:00Z",
        backend: BACKEND_NAMES.CODEX,
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        durationMs: 500,
        ok: true
      }
    ]);
    const s = summarizeCostRecords(records);
    expect(s.total_turns).toBe(3);
    expect(s.ok_turns).toBe(2);
    expect(s.total_tokens).toBe(525);
    expect(s.prompt_tokens).toBe(350);
    expect(s.completion_tokens).toBe(175);
    expect(s.total_duration_ms).toBe(3500);
    expect(s.first_seen).toBe("2026-01-01T00:00:00Z");
    expect(s.last_seen).toBe("2026-01-03T00:00:00Z");
    expect(s.per_backend.claude).toMatchObject({
      turns: 2,
      ok_turns: 1,
      total_tokens: 450,
      total_duration_ms: 3000
    });
    expect(s.per_backend.codex).toMatchObject({
      turns: 1,
      ok_turns: 1,
      total_tokens: 75,
      total_duration_ms: 500
    });
  });

  test("Handles records with missing usage gracefully", () => {
    const records = /** @type {any[]} */ ([
      {
        timestamp: "2026-01-01T00:00:00Z",
        backend: BACKEND_NAMES.CLAUDE,
        durationMs: 100,
        ok: true
      }
    ]);
    const s = summarizeCostRecords(records);
    expect(s.total_tokens).toBe(0);
    expect(s.per_backend.claude.total_tokens).toBe(0);
  });
});

describe("recentCostRecords", () => {
  const records = /** @type {any[]} */ ([
    {
      timestamp: "2026-01-01T00:00:00Z",
      backend: BACKEND_NAMES.CLAUDE,
      ok: true
    },
    {
      timestamp: "2026-01-03T00:00:00Z",
      backend: BACKEND_NAMES.GEMINI,
      ok: true
    },
    {
      timestamp: "2026-01-02T00:00:00Z",
      backend: BACKEND_NAMES.CODEX,
      ok: true
    }
  ]);

  test("Returns the N most recent (newest-first ordering)", () => {
    const recent = recentCostRecords(records, 2);
    expect(recent.map((r) => r.backend)).toEqual([BACKEND_NAMES.GEMINI, BACKEND_NAMES.CODEX]);
  });

  test("n=0 returns empty array", () => {
    expect(recentCostRecords(records, 0)).toEqual([]);
  });

  test("n > total: returns all records sorted", () => {
    expect(recentCostRecords(records, 10)).toHaveLength(3);
  });
});

describe("formatCostSummaryText", () => {
  test("Empty summary: friendly message", () => {
    const s = summarizeCostRecords([]);
    const text = formatCostSummaryText(s);
    expect(text).toMatch(/No cost records/);
  });

  test("Populated summary: includes all sections", () => {
    const s = summarizeCostRecords(
      /** @type {any[]} */ ([
        {
          timestamp: "2026-01-01T00:00:00Z",
          backend: BACKEND_NAMES.CLAUDE,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150
          },
          durationMs: 1000,
          ok: true
        }
      ])
    );
    const text = formatCostSummaryText(s);
    expect(text).toMatch(/Total turns: 1/);
    expect(text).toMatch(/Total tokens: 150/);
    expect(text).toMatch(/Per backend:/);
    expect(text).toMatch(/claude/);
    expect(text).toMatch(/Window:/);
  });
});
