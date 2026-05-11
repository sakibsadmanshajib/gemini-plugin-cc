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

  test("Claude prompt-cache fields surface as cache_creation_tokens / cache_read_tokens", () => {
    const out = normalizeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300
    });
    expect(out.prompt_tokens).toBe(100);
    expect(out.completion_tokens).toBe(50);
    expect(out.cache_creation_tokens).toBe(200);
    expect(out.cache_read_tokens).toBe(300);
    // total is computed: 100 + 50 + 200 + 300 = 650 (cache fields are
    // separate from input_tokens per Anthropic billing).
    expect(out.total_tokens).toBe(650);
  });

  test("Cache fields omitted when zero (keeps record JSONL compact)", () => {
    const out = normalizeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    });
    expect(out).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    });
    expect("cache_creation_tokens" in out).toBe(false);
    expect("cache_read_tokens" in out).toBe(false);
  });

  test("OpenAI shape: cached_tokens from prompt_tokens_details surfaces as cache_read_tokens", () => {
    const out = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 600 }
    });
    expect(out.prompt_tokens).toBe(1000);
    expect(out.cache_read_tokens).toBe(600);
    // total stays at 1100 (cache_read is a SUBSET of prompt_tokens for
    // OpenAI; not double-counted).
    expect(out.total_tokens).toBe(1100);
  });

  test("ACP-server camelCase / codex: cachedInputTokens is a subset of inputTokens (visibility-only)", () => {
    // Real wire shape from `thread/tokenUsage/updated`'s `last` field
    // per codex 0.130.0: `cachedInputTokens` is counted INSIDE
    // `inputTokens`, so total stays at vendor-reported totalTokens
    // (not p + c + cache). We surface `cachedInputTokens` as
    // `cache_read_tokens` for downstream visibility without double
    // counting it.
    const out = normalizeUsage({
      inputTokens: 25544,
      outputTokens: 26,
      cachedInputTokens: 21888,
      reasoningOutputTokens: 19,
      totalTokens: 25570
    });
    expect(out.prompt_tokens).toBe(25544);
    expect(out.completion_tokens).toBe(26);
    expect(out.cache_read_tokens).toBe(21888);
    expect(out.total_tokens).toBe(25570);
    expect("cache_creation_tokens" in out).toBe(false);
  });

  test("ACP-server camelCase / claude-agent-acp: cached* are separate from inputTokens (additive)", () => {
    // Real wire shape from session/prompt response.usage per
    // claude-agent-acp 0.33.1: `cachedReadTokens` and
    // `cachedWriteTokens` are SEPARATE from `inputTokens` (Anthropic
    // billing semantics), and `totalTokens` already accounts for the
    // sum. We surface both cache fields and trust the vendor total.
    const out = normalizeUsage({
      inputTokens: 6,
      outputTokens: 6,
      cachedReadTokens: 20263,
      cachedWriteTokens: 17623,
      totalTokens: 37898
    });
    expect(out.prompt_tokens).toBe(6);
    expect(out.completion_tokens).toBe(6);
    expect(out.cache_creation_tokens).toBe(17623);
    expect(out.cache_read_tokens).toBe(20263);
    expect(out.total_tokens).toBe(37898);
  });

  test("ACP-server camelCase: totalTokens fallback when vendor omits it (claude shape, additive)", () => {
    const out = normalizeUsage({
      inputTokens: 10,
      outputTokens: 20,
      cachedReadTokens: 100,
      cachedWriteTokens: 50
    });
    // No vendor totalTokens → computed as p + c + cacheCreate + cacheRead
    expect(out.total_tokens).toBe(10 + 20 + 50 + 100);
  });

  test("ACP-server camelCase: bare inputTokens/outputTokens without cache fields", () => {
    expect(normalizeUsage({ inputTokens: 12, outputTokens: 34, totalTokens: 46 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46
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

  test("model field is persisted when supplied", () => {
    appendCostRecord(
      {
        backend: BACKEND_NAMES.CLAUDE,
        model: "claude-opus-4-5-20250928",
        promptChars: 42,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        durationMs: 1000,
        reason: "stop",
        ok: true
      },
      { env }
    );
    const lines = fs.readFileSync(getCostLogPath(env), "utf8").trim().split("\n");
    const rec = JSON.parse(lines[0]);
    expect(rec.model).toBe("claude-opus-4-5-20250928");
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
