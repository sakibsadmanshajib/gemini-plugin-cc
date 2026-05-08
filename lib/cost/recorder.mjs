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
  const extracted = defaultExtractTokens("session/prompt", usage);
  if (extracted) {
    return {
      prompt_tokens: extracted.input ?? 0,
      completion_tokens: extracted.output ?? 0,
      total_tokens: extracted.total ?? (extracted.input ?? 0) + (extracted.output ?? 0)
    };
  }
  // Fall back: try OpenAI-shape names directly (some upstreams already use
  // prompt_tokens/completion_tokens — the facade does this).
  const u = /** @type {any} */ (usage);
  if (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") {
    const p = Number(u.prompt_tokens ?? 0);
    const c = Number(u.completion_tokens ?? 0);
    return {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: u.total_tokens ?? p + c
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
