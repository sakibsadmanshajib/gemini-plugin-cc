/**
 * Cost log aggregation — reads `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl`
 * (or `$ARTAGON_COST_LOG` override) and summarizes per-backend totals,
 * recent runs, and date-window slices.
 *
 * Pure-ish functions: file IO is the only side effect; the
 * summarization logic is data-in / data-out so callers can inject a
 * pre-loaded record array (`summarize(records)`) for testing.
 *
 * No persistence beyond the log file itself; the aggregator is
 * read-only.
 */

import fs from "node:fs";

import { estimateUsd, formatUsd } from "#lib/cost/pricing.mjs";
import { getCostLogPath } from "#lib/cost/recorder.mjs";

/**
 * @typedef {import("#lib/cost/recorder.mjs").CostRecord} CostRecord
 * @typedef {import("#lib/cost/pricing.mjs").PricingTable} PricingTable
 *
 * @typedef {{
 *   prompt_tokens: number,
 *   completion_tokens: number,
 *   total_tokens: number,
 *   turns: number,
 *   ok_turns: number,
 *   total_duration_ms: number,
 *   estimated_usd: number
 * }} BackendTotals
 *
 * @typedef {{
 *   total_turns: number,
 *   ok_turns: number,
 *   total_tokens: number,
 *   prompt_tokens: number,
 *   completion_tokens: number,
 *   total_duration_ms: number,
 *   estimated_usd: number,
 *   per_backend: Record<string, BackendTotals>,
 *   first_seen: string | null,
 *   last_seen: string | null
 * }} CostSummary
 */

/**
 * Read all cost records from the log. Malformed lines are silently
 * skipped (best-effort observability).
 *
 * @param {{ env?: NodeJS.ProcessEnv, since?: Date, until?: Date }} [options]
 * @returns {CostRecord[]}
 */
export function readCostRecords(options = {}) {
  const env = options.env ?? process.env;
  const logPath = getCostLogPath(env);
  if (!fs.existsSync(logPath)) return [];

  /** @type {CostRecord[]} */
  const out = [];
  const text = fs.readFileSync(logPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      /** @type {CostRecord} */
      const rec = JSON.parse(line);
      if (typeof rec.timestamp !== "string" || typeof rec.backend !== "string") continue;
      if (options.since && new Date(rec.timestamp) < options.since) continue;
      if (options.until && new Date(rec.timestamp) > options.until) continue;
      out.push(rec);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Summarize an array of cost records into per-backend + global totals.
 *
 * USD estimation (additive — never throws): each turn's tokens are
 * priced via `lib/cost/pricing.mjs` against a vendor rate table
 * (default rates plus per-model overrides). Records without a
 * recognized backend get $0 contribution rather than skipped, so the
 * summary token counts match the dollar counts on the same rows.
 *
 * @param {CostRecord[]} records
 * @param {{ pricingTable?: PricingTable, env?: NodeJS.ProcessEnv }} [options]
 * @returns {CostSummary}
 */
export function summarizeCostRecords(records, options = {}) {
  /** @type {CostSummary} */
  const summary = {
    total_turns: 0,
    ok_turns: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_duration_ms: 0,
    estimated_usd: 0,
    per_backend: {},
    first_seen: null,
    last_seen: null
  };

  for (const rec of records) {
    summary.total_turns += 1;
    if (rec.ok) summary.ok_turns += 1;
    const usage = rec.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };
    summary.prompt_tokens += usage.prompt_tokens;
    summary.completion_tokens += usage.completion_tokens;
    summary.total_tokens += usage.total_tokens;
    summary.total_duration_ms += rec.durationMs ?? 0;

    // Estimate USD for this turn. Model id is opportunistic — claude
    // reports it on every message, codex/gemini may or may not.
    // Pricing falls back to per-backend defaults when null.
    // See lib/cost/pricing.mjs for the table.
    const turnUsd = estimateUsd(rec.backend, rec.model ?? null, usage, {
      table: options.pricingTable,
      env: options.env
    });
    summary.estimated_usd += turnUsd;

    if (!summary.first_seen || rec.timestamp < summary.first_seen) {
      summary.first_seen = rec.timestamp;
    }
    if (!summary.last_seen || rec.timestamp > summary.last_seen) {
      summary.last_seen = rec.timestamp;
    }

    /** @type {BackendTotals} */
    const bt = summary.per_backend[rec.backend] ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      turns: 0,
      ok_turns: 0,
      total_duration_ms: 0,
      estimated_usd: 0
    };
    bt.turns += 1;
    if (rec.ok) bt.ok_turns += 1;
    bt.prompt_tokens += usage.prompt_tokens;
    bt.completion_tokens += usage.completion_tokens;
    bt.total_tokens += usage.total_tokens;
    bt.total_duration_ms += rec.durationMs ?? 0;
    bt.estimated_usd += turnUsd;
    summary.per_backend[rec.backend] = bt;
  }
  return summary;
}

/**
 * Return the N most recent cost records (chronological order; newest
 * first).
 *
 * @param {CostRecord[]} records
 * @param {number} n
 * @returns {CostRecord[]}
 */
export function recentCostRecords(records, n) {
  if (n <= 0) return [];
  return [...records].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, n);
}

/**
 * Format a CostSummary as a human-readable text block. Used by the
 * `bin/artagon-stats` CLI for stdout rendering.
 *
 * @param {CostSummary} summary
 * @returns {string}
 */
export function formatCostSummaryText(summary) {
  if (summary.total_turns === 0) {
    return "No cost records found. Run some turns first or check ARTAGON_COST_LOG.\n";
  }
  const lines = [];
  lines.push(
    `Total turns: ${summary.total_turns} (${summary.ok_turns} ok, ${summary.total_turns - summary.ok_turns} failed)`
  );
  lines.push(
    `Total tokens: ${summary.total_tokens.toLocaleString()} (prompt ${summary.prompt_tokens.toLocaleString()} + completion ${summary.completion_tokens.toLocaleString()})`
  );
  lines.push(`Estimated cost: ${formatUsd(summary.estimated_usd)}`);
  lines.push(`Wall-clock: ${(summary.total_duration_ms / 1000).toFixed(1)}s`);
  if (summary.first_seen && summary.last_seen) {
    lines.push(`Window: ${summary.first_seen} → ${summary.last_seen}`);
  }
  lines.push("");
  lines.push("Per backend:");
  const backends = Object.keys(summary.per_backend).sort();
  for (const backend of backends) {
    const bt = summary.per_backend[backend];
    lines.push(
      `  ${backend.padEnd(8)} ${String(bt.turns).padStart(5)} turns ` +
        `(${bt.ok_turns} ok)  ` +
        `${bt.total_tokens.toLocaleString().padStart(10)} tokens  ` +
        `${formatUsd(bt.estimated_usd).padStart(8)}  ` +
        `${(bt.total_duration_ms / 1000).toFixed(1).padStart(6)}s`
    );
  }
  return `${lines.join("\n")}\n`;
}
