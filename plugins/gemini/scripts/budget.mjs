#!/usr/bin/env node
/**
 * Entry script for `/gemini:budget` (installed in Gemini CLI or any host).
 *
 * Compares aggregate token usage from the cost log against a token
 * budget and prints how much is remaining (or by how much it's
 * exceeded). Pure read — never blocks a turn; this is observability
 * to drive user awareness, not a hard ceiling.
 *
 * Budget resolution (in order of precedence):
 *   1. `--limit <n>` flag
 *   2. `$ARTAGON_BUDGET_TOKENS` env var
 *   3. Default: 1,000,000 tokens
 *
 * Window resolution:
 *   - `--since <iso>` / `--until <iso>` filter the records considered
 *   - Default: count all-time
 *   - `--month` shorthand sets `since` to the first of the current
 *     calendar month (UTC) — common monthly-budget workflow
 *
 * Output:
 *   Budget: 1,000,000 tokens
 *   Used:     124,000 (12.4%)
 *   Left:     876,000
 *   Status: ✓ within budget
 *
 * Or, on overage:
 *   Status: ✗ over by 24,000 tokens (102.4%)
 *
 * Exit code is always 0 — the host displays the report; downstream
 * tooling that wants gating can read `--json` and decide.
 */

import process from "node:process";

import { readCostRecords, summarizeCostRecords } from "#lib/cost/aggregate.mjs";
import { formatUsd } from "#lib/cost/pricing.mjs";

const DEFAULT_BUDGET = 1_000_000;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ json?: boolean, limit?: number, limitUsd?: number, since?: Date, until?: Date, month?: boolean }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--json") out.json = true;
    else if (tok === "--month") out.month = true;
    else if (tok === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --limit: ${argv[i]}`);
      out.limit = n;
    } else if (tok === "--limit-usd") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --limit-usd: ${argv[i]}`);
      out.limitUsd = n;
    } else if (tok === "--since") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --since: ${argv[i]}`);
      out.since = d;
    } else if (tok === "--until") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --until: ${argv[i]}`);
      out.until = d;
    }
    // unknown tokens silently ignored — slash-command shells may pass
    // free-form text we don't need.
  }
  return out;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`budget: ${/** @type {Error} */ (err).message}\n`);
  process.exit(2);
}

// Resolve token + USD budgets in parallel. `--limit-usd` takes
// precedence as the primary budget when set; otherwise we use the
// token budget. Both numbers are always shown so users see how
// they relate.
const envBudget = Number(process.env.ARTAGON_BUDGET_TOKENS);
const envBudgetUsd = Number(process.env.ARTAGON_BUDGET_USD);
const tokenBudget =
  opts.limit ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_BUDGET);
const usdBudget =
  opts.limitUsd ?? (Number.isFinite(envBudgetUsd) && envBudgetUsd > 0 ? envBudgetUsd : null);
const usdMode = usdBudget !== null;

let since = opts.since;
if (opts.month && !since) {
  const now = new Date();
  since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const records = readCostRecords({ since, until: opts.until });
const summary = summarizeCostRecords(records);
const usedTokens = summary.total_tokens;
const usedUsd = summary.estimated_usd;

// Primary budget vs used (the one we gate "within/over" on)
const primaryLimit = usdMode ? /** @type {number} */ (usdBudget) : tokenBudget;
const primaryUsed = usdMode ? usedUsd : usedTokens;
const remaining = primaryLimit - primaryUsed;
const pct = primaryLimit > 0 ? (primaryUsed / primaryLimit) * 100 : 0;

const windowLabel = opts.month
  ? `(this month, ${since?.toISOString().slice(0, 10)} →)`
  : since
    ? `(since ${since.toISOString()})`
    : "(all time)";

if (opts.json) {
  const out = {
    budget: {
      tokens: tokenBudget,
      usd: usdBudget,
      mode: usdMode ? "usd" : "tokens"
    },
    used: { tokens: usedTokens, usd: usedUsd },
    remaining,
    pct,
    status: remaining >= 0 ? "within_budget" : "over_budget",
    window: {
      since: since?.toISOString() ?? null,
      until: opts.until?.toISOString() ?? null
    },
    summary
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

/** @param {number} n */
const fmt = (n) => Math.round(n).toLocaleString();
const overText = usdMode
  ? `${formatUsd(-remaining)} (${pct.toFixed(1)}%)`
  : `${fmt(-remaining)} tokens (${pct.toFixed(1)}%)`;
const status = remaining >= 0 ? "OK within budget" : `OVER by ${overText}`;

process.stdout.write(`Budget ${windowLabel}\n`);
if (usdMode) {
  process.stdout.write(`  Limit:  ${formatUsd(primaryLimit).padStart(12)} (USD)\n`);
  process.stdout.write(`  Used:   ${formatUsd(usedUsd).padStart(12)} (${pct.toFixed(1)}%)\n`);
  process.stdout.write(`  Tokens: ${fmt(usedTokens).padStart(12)} (informational)\n`);
  process.stdout.write(`  Left:   ${formatUsd(remaining).padStart(12)}\n`);
} else {
  process.stdout.write(`  Limit:  ${fmt(tokenBudget).padStart(12)} tokens\n`);
  process.stdout.write(`  Used:   ${fmt(usedTokens).padStart(12)} (${pct.toFixed(1)}%)\n`);
  process.stdout.write(`  Cost:   ${formatUsd(usedUsd).padStart(12)} (informational)\n`);
  process.stdout.write(`  Left:   ${fmt(remaining).padStart(12)} tokens\n`);
}
process.stdout.write(`  Status: ${status}\n`);
process.exit(0);
