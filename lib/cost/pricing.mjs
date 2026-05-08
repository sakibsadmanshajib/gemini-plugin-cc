/**
 * Token-to-USD pricing tables for the three CLI backends.
 *
 * The CLI runners are stateless wrappers around the vendor CLIs, so
 * the cost log captures whatever model the CLI was configured to use.
 * The pricing here is keyed by `backend` (claude / codex / gemini) +
 * an optional `model` substring match. When the exact model isn't
 * recorded (the runners don't currently capture model id), we fall
 * back to a per-backend default rate that approximates the most
 * commonly-used model in each family.
 *
 * Why approximate:
 *   - The cost log records `usage` from the CLI's own metadata; it
 *     doesn't always include the model id (Claude `--print` does,
 *     Codex `exec --json` does, Gemini doesn't always).
 *   - Per-backend defaults are intentionally conservative — better
 *     to over-estimate cost so users don't get surprised, and to
 *     under-promise on /budget.
 *
 * Rates are USD per 1M tokens. Prompt and completion are tracked
 * separately because they're priced differently for every model.
 *
 * Source-of-truth references (as of 2026-05):
 *   - Claude Sonnet/Haiku/Opus: https://www.anthropic.com/pricing
 *   - GPT-5 / o-series: https://openai.com/api/pricing
 *   - Gemini Pro/Flash: https://ai.google.dev/pricing
 *
 * Update this table as vendor pricing changes; ARTAGON_PRICING_OVERRIDE
 * lets callers inject a JSON pricing table at runtime to avoid
 * needing a release for every vendor price change.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";

/**
 * @typedef {{
 *   input_per_million: number,
 *   output_per_million: number
 * }} PriceRow
 *
 * @typedef {{
 *   default: PriceRow,
 *   models?: Record<string, PriceRow>
 * }} BackendPricing
 *
 * @typedef {Record<string, BackendPricing>} PricingTable
 */

/**
 * Default pricing table. USD per 1M tokens.
 *
 * @type {PricingTable}
 */
export const DEFAULT_PRICING = {
  [BACKEND_NAMES.CLAUDE]: {
    // Default to Sonnet rates — the most commonly-driven Claude model
    // through the CLI. Opus is roughly 5x; haiku is roughly 1/3.
    default: { input_per_million: 3.0, output_per_million: 15.0 },
    models: {
      "claude-opus": { input_per_million: 15.0, output_per_million: 75.0 },
      "claude-sonnet": { input_per_million: 3.0, output_per_million: 15.0 },
      "claude-haiku": { input_per_million: 0.8, output_per_million: 4.0 }
    }
  },
  [BACKEND_NAMES.CODEX]: {
    // GPT-5 default; o-series and gpt-5-codex variants priced similarly.
    default: { input_per_million: 1.25, output_per_million: 10.0 },
    models: {
      "gpt-5": { input_per_million: 1.25, output_per_million: 10.0 },
      "gpt-5-codex": { input_per_million: 1.25, output_per_million: 10.0 },
      o3: { input_per_million: 2.0, output_per_million: 8.0 },
      o4: { input_per_million: 3.0, output_per_million: 12.0 }
    }
  },
  [BACKEND_NAMES.GEMINI]: {
    // Gemini 2.5 Pro default; Flash is roughly 1/10.
    default: { input_per_million: 1.25, output_per_million: 10.0 },
    models: {
      "gemini-2.5-pro": { input_per_million: 1.25, output_per_million: 10.0 },
      "gemini-3-pro": { input_per_million: 2.5, output_per_million: 15.0 },
      "gemini-2.5-flash": { input_per_million: 0.075, output_per_million: 0.3 },
      "gemini-3-flash": { input_per_million: 0.1, output_per_million: 0.4 }
    }
  }
};

/**
 * Resolve the pricing table to use. Order:
 *   1. `options.table` direct injection
 *   2. `$ARTAGON_PRICING_OVERRIDE` JSON in env (full table replacement)
 *   3. DEFAULT_PRICING
 *
 * @param {{ env?: NodeJS.ProcessEnv, table?: PricingTable }} [options]
 * @returns {PricingTable}
 */
export function resolvePricingTable(options = {}) {
  if (options.table) return options.table;
  const env = options.env ?? process.env;
  const override = env.ARTAGON_PRICING_OVERRIDE;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Bad JSON — fall through to defaults rather than crash.
    }
  }
  return DEFAULT_PRICING;
}

/**
 * Look up the price row for a backend + optional model id. The model
 * id is matched against the `models` keys via prefix/substring; e.g.
 * "claude-opus-4-5-20250928" matches the "claude-opus" key. Returns
 * the backend's default if no model match.
 *
 * Returns null if the backend isn't in the pricing table at all
 * (caller should treat as "unknown — no estimate").
 *
 * @param {string} backend
 * @param {string | null | undefined} model
 * @param {PricingTable} table
 * @returns {PriceRow | null}
 */
export function lookupPrice(backend, model, table) {
  const row = table[backend];
  if (!row) return null;
  if (model && row.models) {
    // Find the longest matching model key — "claude-opus" beats "claude"
    // when the input is "claude-opus-4-5".
    let best = null;
    let bestLen = 0;
    for (const key of Object.keys(row.models)) {
      if (model.includes(key) && key.length > bestLen) {
        best = row.models[key];
        bestLen = key.length;
      }
    }
    if (best) return best;
  }
  return row.default;
}

/**
 * Compute USD cost for a single (prompt_tokens, completion_tokens) pair
 * at the rate for the given backend + model. Returns 0 when no pricing
 * is available rather than null — the caller is summing across backends
 * and a missing rate shouldn't poison the sum (it'll just under-count,
 * which is the safer direction for a default).
 *
 * @param {string} backend
 * @param {string | null | undefined} model
 * @param {{ prompt_tokens?: number, completion_tokens?: number }} usage
 * @param {{ table?: PricingTable, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function estimateUsd(backend, model, usage, options = {}) {
  const table = resolvePricingTable(options);
  const price = lookupPrice(backend, model, table);
  if (!price) return 0;
  // Defensive coercion: a malformed cost log entry could put a string
  // in prompt_tokens (`Number("garbage") === NaN`). NaN propagates
  // through arithmetic and would poison the summary with NaN. Force
  // any non-finite numeric to 0 so the dollar estimate degrades to
  // zero on this row rather than corrupting the global total.
  const safe = (/** @type {unknown} */ v) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const prompt = safe(usage.prompt_tokens);
  const completion = safe(usage.completion_tokens);
  return (
    (prompt / 1_000_000) * price.input_per_million +
    (completion / 1_000_000) * price.output_per_million
  );
}

/**
 * Format a USD amount to a human-readable string. Cents granularity
 * for amounts ≥ $1; mils (1/10 cent) for smaller amounts so we don't
 * round small free-tier turns to "$0.00".
 *
 * @param {number} usd
 * @returns {string}
 */
export function formatUsd(usd) {
  if (!Number.isFinite(usd)) return "$?";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
