/**
 * Cost recorder — appends per-turn token + duration records to a
 * JSONL log file under `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl`
 * (default `~/.local/state/artagon-agent-cli-plugin/cost.jsonl`).
 *
 * Each line is one finished turn:
 *
 *   {
 *     timestamp,           // ISO 8601
 *     backend,             // claude / codex / gemini
 *     sessionId,           // optional; populated when caller knows
 *     promptChars,         // input prompt length (cheap proxy when token usage is null)
 *     usage,               // { prompt_tokens, completion_tokens, total_tokens } — normalized
 *     durationMs,          // wall-clock from spawn to resolve
 *     reason,              // turn reason (success / end_turn / error_max_turns / etc.)
 *     ok                   // boolean: did the runner resolve cleanly
 *   }
 *
 * Why JSONL: append-only writes are race-safe across concurrent
 * runners. Aggregation (`lib/cost/aggregate.mjs`) reads the whole file
 * and summarizes; rotation is a future concern (the file grows
 * unbounded today; rotate by date or size when it becomes an issue).
 *
 * Why XDG_STATE_HOME: per the project's XDG contract. Generated state,
 * not config.
 *
 * Failure mode: silent. Cost recording is observability — if the
 * directory is unwritable or the disk is full, we don't want runners
 * to fail. Errors are written once to stderr and subsequent attempts
 * are skipped.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultExtractTokens } from "#lib/middleware/cost.mjs";

/**
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} NormalizedUsage
 *
 * @typedef {{
 *   timestamp: string,
 *   backend: import("#lib/backends/names.mjs").BackendName,
 *   sessionId?: string,
 *   promptChars: number,
 *   usage: NormalizedUsage,
 *   durationMs: number,
 *   reason: string | null,
 *   ok: boolean
 * }} CostRecord
 */

let warnedOnce = false;

/**
 * Resolve the cost log path. `$ARTAGON_COST_LOG` overrides; otherwise
 * `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (default
 * `~/.local/state/...`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getCostLogPath(env = process.env) {
  if (env.ARTAGON_COST_LOG) return env.ARTAGON_COST_LOG;
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "artagon-agent-cli-plugin", "cost.jsonl");
}

/**
 * Normalize a TurnResult's `usage` field across all three backend
 * shapes to `{prompt_tokens, completion_tokens, total_tokens}`. Missing
 * fields default to 0.
 *
 * @param {unknown} usage
 * @returns {NormalizedUsage}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const u = /** @type {any} */ (usage);

  // Claude / Codex bare shape: { input_tokens, output_tokens }.
  // TurnResult.usage is THIS shape (not the {usage: {...}} wrapper that
  // defaultExtractTokens expects), so check it directly first. A prior
  // version delegated straight to defaultExtractTokens and got 0 tokens
  // for every claude/codex turn — caught by code review.
  if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") {
    const p = Number(u.input_tokens ?? 0);
    const c = Number(u.output_tokens ?? 0);
    return {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : p + c
    };
  }

  // Gemini bare shape: { promptTokenCount, candidatesTokenCount, totalTokenCount }
  if (typeof u.promptTokenCount === "number" || typeof u.candidatesTokenCount === "number") {
    const p = Number(u.promptTokenCount ?? 0);
    const c = Number(u.candidatesTokenCount ?? 0);
    return {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: typeof u.totalTokenCount === "number" ? u.totalTokenCount : p + c
    };
  }

  // OpenAI bare shape: { prompt_tokens, completion_tokens, total_tokens }
  if (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") {
    const p = Number(u.prompt_tokens ?? 0);
    const c = Number(u.completion_tokens ?? 0);
    return {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : p + c
    };
  }

  // Wrapper shape: { usage: {...} } / { usageMetadata: {...} } — delegate
  // to the middleware extractor (kept for back-compat with anything that
  // hands in the wrapper instead of the bare usage record).
  const extracted = defaultExtractTokens("session/prompt", u);
  if (extracted) {
    return {
      prompt_tokens: extracted.input ?? 0,
      completion_tokens: extracted.output ?? 0,
      total_tokens: extracted.total ?? (extracted.input ?? 0) + (extracted.output ?? 0)
    };
  }

  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/**
 * Append a cost record to the log file. Best-effort: failures are
 * warned once on stderr and silently ignored thereafter (cost recording
 * is observability, not load-bearing).
 *
 * @param {Omit<CostRecord, "timestamp">} record
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 */
export function appendCostRecord(record, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const logPath = getCostLogPath(env);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    /** @type {CostRecord} */
    const full = { ...record, timestamp: now().toISOString() };
    fs.appendFileSync(logPath, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      const message = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(`[cost-recorder] disabled — failed to write ${logPath}: ${message}\n`);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Reset the warned-once flag — for tests that want to re-arm the
 * stderr warning after a deliberate-fail simulation.
 */
export function _resetWarnedForTests() {
  warnedOnce = false;
}
