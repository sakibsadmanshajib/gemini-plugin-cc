/**
 * Unit tests for lib/cost/recorder.mjs.
 *
 * Coverage:
 *   - getCostLogPath: ARTAGON_COST_LOG override + XDG_STATE_HOME fallback
 *   - normalizeUsage: each documented backend shape (Claude/Codex
 *     input_tokens, Gemini promptTokenCount, OpenAI prompt_tokens, null)
 *   - appendCostRecord: writes valid JSONL with timestamp + body
 *   - appendCostRecord: silent on unwritable path (no throw)
 *   - appendCostRecord with mocked `now` for deterministic timestamps
 *
 * Each test creates a unique temp dir + scoped env so concurrent
 * tests don't race on the cost log file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  _resetWarnedForTests,
  appendCostRecord,
  getCostLogPath,
  normalizeUsage
} from "#lib/cost/recorder.mjs";

/** @type {string} */
let tmpDir;
/** @type {NodeJS.ProcessEnv} */
let env;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cost-recorder-${crypto.randomBytes(4).toString("hex")}-`)
  );
  // Use ARTAGON_COST_LOG to point at a per-test file inside the temp dir.
  env = { ...process.env, ARTAGON_COST_LOG: path.join(tmpDir, "cost.jsonl") };
  _resetWarnedForTests();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("getCostLogPath", () => {
  test("ARTAGON_COST_LOG override wins", () => {
    expect(getCostLogPath({ ARTAGON_COST_LOG: "/custom/path.jsonl" })).toBe("/custom/path.jsonl");
  });

  test("XDG_STATE_HOME fallback", () => {
    expect(getCostLogPath({ XDG_STATE_HOME: "/xdg/state" })).toBe(
      "/xdg/state/artagon-agent-cli-plugin/cost.jsonl"
    );
  });

  test("Default to ~/.local/state when neither env set", () => {
    expect(getCostLogPath({})).toBe(
      path.join(os.homedir(), ".local", "state", "artagon-agent-cli-plugin", "cost.jsonl")
    );
  });
});

describe("normalizeUsage", () => {
  test("null/undefined/non-object returns zeros", () => {
    expect(normalizeUsage(null)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    });
    expect(normalizeUsage(undefined)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    });
    expect(normalizeUsage("string")).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    });
  });

  test("Claude / Codex shape: input_tokens / output_tokens", () => {
    expect(normalizeUsage({ input_tokens: 100, output_tokens: 50 })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    });
  });

  test("Gemini shape: promptTokenCount / candidatesTokenCount / totalTokenCount", () => {
    expect(
      normalizeUsage({
        promptTokenCount: 80,
        candidatesTokenCount: 40,
        totalTokenCount: 120
      })
    ).toEqual({ prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 });
  });

  test("OpenAI shape: prompt_tokens / completion_tokens (passthrough fallback)", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 30,
        completion_tokens: 15,
        total_tokens: 45
      })
    ).toEqual({ prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 });
  });

  test("OpenAI shape with missing total_tokens: derives from prompt + completion", () => {
    expect(normalizeUsage({ prompt_tokens: 30, completion_tokens: 15 })).toEqual({
      prompt_tokens: 30,
      completion_tokens: 15,
      total_tokens: 45
    });
  });

  test("Unknown shape returns zeros", () => {
    expect(normalizeUsage({ tokens: 99, units: 1 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    });
  });
});

describe("appendCostRecord", () => {
  test("Writes a valid JSONL line with all fields + timestamp", () => {
    const fixedNow = new Date("2026-05-08T19:00:00Z");
    appendCostRecord(
      {
        backend: BACKEND_NAMES.CLAUDE,
        promptChars: 42,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        durationMs: 1234,
        reason: "stop",
        ok: true
      },
      { env, now: () => fixedNow }
    );

    const logPath = getCostLogPath(env);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec).toEqual({
      timestamp: "2026-05-08T19:00:00.000Z",
      backend: BACKEND_NAMES.CLAUDE,
      promptChars: 42,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      durationMs: 1234,
      reason: "stop",
      ok: true
    });
  });

  test("Multiple appends: each on its own line", () => {
    appendCostRecord(
      {
        backend: BACKEND_NAMES.CODEX,
        promptChars: 1,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        durationMs: 10,
        reason: "end_turn",
        ok: true
      },
      { env }
    );
    appendCostRecord(
      {
        backend: BACKEND_NAMES.GEMINI,
        promptChars: 2,
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        durationMs: 20,
        reason: null,
        ok: false
      },
      { env }
    );
    const lines = fs.readFileSync(getCostLogPath(env), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs[0].backend).toBe(BACKEND_NAMES.CODEX);
    expect(recs[1].backend).toBe(BACKEND_NAMES.GEMINI);
  });

  test("Creates parent directory if missing", () => {
    const nested = path.join(tmpDir, "deep", "nested", "cost.jsonl");
    appendCostRecord(
      {
        backend: BACKEND_NAMES.CLAUDE,
        promptChars: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        durationMs: 0,
        reason: null,
        ok: true
      },
      { env: { ARTAGON_COST_LOG: nested } }
    );
    expect(fs.existsSync(nested)).toBe(true);
  });

  test("Silent on unwritable path: no throw, no log file created", () => {
    // /dev/null/anything is unwritable on Unix; mkdir returns ENOTDIR.
    const badEnv = { ARTAGON_COST_LOG: "/dev/null/cannot/create/here.jsonl" };
    expect(() =>
      appendCostRecord(
        {
          backend: BACKEND_NAMES.CLAUDE,
          promptChars: 0,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          durationMs: 0,
          reason: null,
          ok: true
        },
        { env: badEnv }
      )
    ).not.toThrow();
    expect(fs.existsSync("/dev/null/cannot/create/here.jsonl")).toBe(false);
  });
});
