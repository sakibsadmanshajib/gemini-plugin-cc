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
 * Normalized per-turn token usage. Cache fields are optional because
 * not every backend reports them — Claude does (`cache_creation_input_tokens`
 * + `cache_read_input_tokens`), OpenAI does (`cached_input_tokens` from
 * GPT-4o+), Gemini does not (yet) surface cache info in its CLI output.
 *
 * Pricing semantics (vendor docs as of 2026-05):
 *   - prompt_tokens: regular input, billed at the model's input rate
 *   - cache_creation_tokens: cache writes, Claude charges +25% over input
 *   - cache_read_tokens: cache hits, charged at 10% (Claude) / 50% (OpenAI)
 *   - completion_tokens: output, billed at the model's output rate
 *
 * For Anthropic's published cache rates, the cache_creation tokens
 * are NOT also counted in prompt_tokens (separate), so summing
 * prompt + cache_creation + cache_read avoids double-counting.
 *
 * @typedef {{
 *   prompt_tokens: number,
 *   completion_tokens: number,
 *   total_tokens: number,
 *   cache_creation_tokens?: number,
 *   cache_read_tokens?: number
 * }} NormalizedUsage
 *
 * @typedef {{
 *   timestamp: string,
 *   backend: import("#lib/backends/names.mjs").BackendName,
 *   sessionId?: string,
 *   model?: string | null,
 *   promptChars: number,
 *   usage: NormalizedUsage,
 *   durationMs: number,
 *   reason: string | null,
 *   ok: boolean,
 *   transport?: import("./transport-names.mjs").TransportName
 * }} CostRecord
 *
 * Use `TRANSPORT_NAMES` from `./transport-names.mjs` instead of bare
 * string literals at call sites — single source of truth.
 *
 * The `transport` field describes HOW the turn reached the backend:
 *   - "cli": cold-start subprocess (today's default for one-shot runners)
 *   - "broker": connected to a long-running gemini --acp broker via Unix
 *               socket (Phase 0 of add-unified-acp-server-with-mcp-aggregation)
 *   - "facade": routed through artagon-openai-server (cache-friendly)
 *   - "acp-server": routed through artagon-acp-server (Phase 1+) OR the
 *                   gemini streaming runner that owns its own ACP session
 *                   over the legacy broker socket
 *   - "codex-app-server": routed through `codex app-server` JSON-RPC 2.0
 *                   (codex's own thread/turn/item schema, NOT Zed's ACP
 *                   wire format — kept distinct so per-backend warm-path
 *                   latency stays separable in aggregations)
 *   - "claude-agent-acp": routed through `@agentclientprotocol/claude-agent-acp`
 *                   (Zed's ACP wrapper around the Claude Agent SDK). Wire
 *                   format IS standard ACP; label is distinct because the
 *                   underlying auth + tool surface differs from the `claude`
 *                   CLI path (Anthropic API + agent-SDK tools rather than
 *                   the CLI's tool set).
 *
 * Absent on legacy records (introduced 2026-05); aggregation tooling
 * treats absent as "cli" for back-compat.
 */

let warnedOnce = false;

/**
 * Resolve the cost log path. Precedence:
 *   1. `context.cost.logPath`
 *   2. `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl`
 *      (default `~/.local/state/...`)
 *
 * The `ARTAGON_COST_LOG` env-var fallback was removed in Phase 4 of
 * the AgentContext refactor — env is read at the boundary
 * (`lib/agent-context.mjs::buildAgentContextFromArgv`) and translated
 * into `context.cost.logPath`. Lib code does NOT read
 * `process.env.ARTAGON_*` directly.
 *
 * `XDG_STATE_HOME` is a host-set system contract (not internal config)
 * and is intentionally still read for the default fallback path.
 *
 * @param {NodeJS.ProcessEnv | undefined} [env]
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {string}
 */
export function getCostLogPath(env, context) {
  if (context?.cost?.logPath) return context.cost.logPath;
  const e = env ?? process.env;
  const stateHome = e.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
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

  // Claude / Codex bare shape: { input_tokens, output_tokens, ... }.
  // TurnResult.usage is THIS shape (not the {usage: {...}} wrapper that
  // defaultExtractTokens expects), so check it directly first. A prior
  // version delegated straight to defaultExtractTokens and got 0 tokens
  // for every claude/codex turn — caught by code review.
  //
  // Claude additionally reports prompt-cache fields:
  //   cache_creation_input_tokens — cache writes (priced +25% over input)
  //   cache_read_input_tokens     — cache hits  (priced at 10% of input)
  // These are NOT included in input_tokens (per Anthropic's billing
  // semantics), so we surface them as separate normalized fields.
  if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") {
    const p = Number(u.input_tokens ?? 0);
    const c = Number(u.output_tokens ?? 0);
    const cacheCreate = Number(u.cache_creation_input_tokens ?? 0);
    const cacheRead = Number(u.cache_read_input_tokens ?? 0);
    /** @type {NormalizedUsage} */
    const out = {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens:
        typeof u.total_tokens === "number" ? u.total_tokens : p + c + cacheCreate + cacheRead
    };
    if (cacheCreate > 0) out.cache_creation_tokens = cacheCreate;
    if (cacheRead > 0) out.cache_read_tokens = cacheRead;
    return out;
  }

  // ACP-server camelCase shape, used by both:
  //   - codex `thread/tokenUsage/updated`'s `last`/`total` objects:
  //       { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, totalTokens }
  //     (cachedInputTokens is a SUBSET of inputTokens — already counted)
  //   - claude-agent-acp `session/prompt` response.usage:
  //       { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens }
  //     (cached* are SEPARATE from inputTokens — additive, per Anthropic billing)
  //
  // Two distinct shapes share the same family, so this branch detects
  // them together and uses the field names that are actually present.
  // The semantic difference (subset vs additive cache) only matters for
  // the totalTokens fallback computation, which we sidestep by
  // preferring the vendor-reported totalTokens whenever present.
  if (typeof u.inputTokens === "number" || typeof u.outputTokens === "number") {
    const p = Number(u.inputTokens ?? 0);
    const c = Number(u.outputTokens ?? 0);
    // claude-agent-acp pattern (cache fields separate from input)
    const claudeCacheRead = Number(u.cachedReadTokens ?? 0);
    const claudeCacheCreate = Number(u.cachedWriteTokens ?? 0);
    // codex pattern (cached is subset of input — surface as cache_read for
    // visibility but do NOT add to total)
    const codexCacheRead = Number(u.cachedInputTokens ?? 0);
    /** @type {NormalizedUsage} */
    const out = {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens:
        typeof u.totalTokens === "number"
          ? u.totalTokens
          : p + c + claudeCacheCreate + claudeCacheRead
    };
    if (claudeCacheCreate > 0) out.cache_creation_tokens = claudeCacheCreate;
    if (claudeCacheRead > 0) out.cache_read_tokens = claudeCacheRead;
    else if (codexCacheRead > 0) out.cache_read_tokens = codexCacheRead;
    return out;
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

  // OpenAI bare shape: { prompt_tokens, completion_tokens, total_tokens,
  //                      prompt_tokens_details: { cached_tokens? } }.
  // GPT-4o+ reports cached input tokens at 50% of the input rate;
  // they're INCLUDED in prompt_tokens (unlike Claude), so we surface
  // cache_read_tokens as a derived view without subtracting from
  // prompt_tokens. The pricing layer is responsible for crediting the
  // discount: regular = prompt_tokens - cache_read; discounted = cache_read.
  if (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number") {
    const p = Number(u.prompt_tokens ?? 0);
    const c = Number(u.completion_tokens ?? 0);
    const cacheRead = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
    /** @type {NormalizedUsage} */
    const out = {
      prompt_tokens: p,
      completion_tokens: c,
      total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : p + c
    };
    if (cacheRead > 0) out.cache_read_tokens = cacheRead;
    return out;
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
 * Precedence for resolving the log destination:
 *   1. `options.context.cost.disabled === true` → skip entirely
 *   2. `options.context.cost.logPath`           → override
 *   3. `options.env.ARTAGON_COST_LOG`           → env fallback (Phase 4 removes)
 *   4. `$XDG_STATE_HOME/.../cost.jsonl`         → default
 *
 * @param {Omit<CostRecord, "timestamp">} record
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => Date,
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * }} [options]
 */
export function appendCostRecord(record, options = {}) {
  if (options.context?.cost?.disabled === true) return;
  const env = options.context?.env ?? options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const logPath = getCostLogPath(env, options.context);
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
