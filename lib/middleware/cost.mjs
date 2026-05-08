/**
 * Cost middleware — accumulates per-session token + call counts for the
 * `/agent:cost` slash command (and any other observability consumer).
 *
 * What it tracks:
 *   - `prompts`: count of `session/prompt` requests
 *   - `toolCalls`: count of `tool_call` notifications observed inbound
 *   - `errors`: count of failed requests (rejected promises)
 *   - `tokens`: cumulative `{ input, output, total }` extracted by a
 *     pluggable `extractTokens` function. Different backends ship
 *     usage info in different result shapes:
 *       - Codex SDK: `result.usage = { input_tokens, output_tokens }`
 *       - Claude: `result.usage = { input_tokens, output_tokens }` (same)
 *       - Gemini: `result.usageMetadata = { promptTokenCount, candidatesTokenCount, totalTokenCount }`
 *     The default extractor handles all three shapes; backends with
 *     non-standard shapes pass a custom extractor.
 *
 * IMPORTANT: cost numbers are NON-AUTHORITATIVE. The provider's billing
 * console is the source of truth. Cost middleware exists for in-session
 * feedback ("am I racking up tokens?") and trend analysis, not invoicing.
 *
 * Position: AFTER redaction (so token counts derive from already-redacted
 * payloads — secrets in counts would be ironic). Before retry (so retry's
 * extra attempts get counted as separate prompts, which is the truth).
 */

import crypto from "node:crypto";

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 *
 * @typedef {{ input: number, output: number, total: number }} TokenCounts
 *
 * @typedef {{
 *   sessionId: string,
 *   startedAt: string,
 *   endedAt: string | null,
 *   counts: { prompts: number, toolCalls: number, errors: number },
 *   tokens: TokenCounts
 * }} CostRecord
 *
 * @typedef {(method: string, result: unknown) => Partial<TokenCounts> | null} TokenExtractor
 *
 * @typedef {{
 *   sessionId?: string,
 *   extractTokens?: TokenExtractor,
 *   onUpdate?: (record: CostRecord) => void
 * }} CostConfig
 */

/**
 * Default token extractor. Recognizes the three known result shapes:
 *   - `result.usage = { input_tokens, output_tokens }` — Codex / Claude
 *   - `result.usageMetadata = { promptTokenCount, candidatesTokenCount, totalTokenCount }` — Gemini
 *
 * Returns null when the result doesn't carry usage info (most non-prompt
 * methods).
 *
 * @type {TokenExtractor}
 */
export function defaultExtractTokens(_method, result) {
  if (!result || typeof result !== "object") return null;
  const r = /** @type {any} */ (result);

  // Codex / Claude shape.
  if (r.usage && typeof r.usage === "object") {
    const input = Number(r.usage.input_tokens ?? r.usage.inputTokens ?? 0);
    const output = Number(r.usage.output_tokens ?? r.usage.outputTokens ?? 0);
    return { input, output, total: input + output };
  }

  // Gemini shape.
  if (r.usageMetadata && typeof r.usageMetadata === "object") {
    const input = Number(r.usageMetadata.promptTokenCount ?? 0);
    const output = Number(r.usageMetadata.candidatesTokenCount ?? 0);
    const total = Number(r.usageMetadata.totalTokenCount ?? input + output);
    return { input, output, total };
  }

  return null;
}

/**
 * @param {CostConfig} [userConfig]
 * @returns {Middleware & { record: () => CostRecord }}
 */
export function createCostMiddleware(userConfig = {}) {
  // crypto.randomBytes — Math.random is unsuitable for session IDs in a
  // security-relevant context (CodeQL js/insecure-randomness). Cost
  // records are keyed by sessionId; predictable ids would let an
  // attacker correlate or interfere with another session's accounting.
  const sessionId =
    userConfig.sessionId ?? `s-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const extract = userConfig.extractTokens ?? defaultExtractTokens;
  const onUpdate = userConfig.onUpdate;

  /** @type {CostRecord} */
  const record = {
    sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    counts: { prompts: 0, toolCalls: 0, errors: 0 },
    tokens: { input: 0, output: 0, total: 0 }
  };

  function fireUpdate() {
    onUpdate?.({
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      counts: { ...record.counts },
      tokens: { ...record.tokens }
    });
  }

  return {
    name: "cost",
    record: () => ({
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      counts: { ...record.counts },
      tokens: { ...record.tokens }
    }),
    wrap(next) {
      return {
        start: () => next.start(),
        async request(method, params) {
          if (method === "session/prompt") record.counts.prompts += 1;
          try {
            const result = await next.request(method, params);
            const tokens = extract(method, result);
            if (tokens) {
              record.tokens.input += tokens.input ?? 0;
              record.tokens.output += tokens.output ?? 0;
              record.tokens.total += tokens.total ?? (tokens.input ?? 0) + (tokens.output ?? 0);
            }
            fireUpdate();
            return result;
          } catch (err) {
            record.counts.errors += 1;
            fireUpdate();
            throw err;
          }
        },
        notify: (method, params) => next.notify(method, params),
        onNotification(handler) {
          return next.onNotification((notification) => {
            const update = /** @type {any} */ (notification.params)?.update;
            if (update?.sessionUpdate === "tool_call") {
              record.counts.toolCalls += 1;
              fireUpdate();
            }
            handler(notification);
          });
        },
        onHealthChange: (handler) => next.onHealthChange(handler),
        healthState: () => next.healthState(),
        async close() {
          record.endedAt = new Date().toISOString();
          fireUpdate();
          await next.close();
        },
        isOpen: () => next.isOpen()
      };
    }
  };
}
