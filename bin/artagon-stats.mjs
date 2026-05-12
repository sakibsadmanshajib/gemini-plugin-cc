#!/usr/bin/env node
/**
 * `artagon-stats` — print aggregate cost statistics from the local
 * cost-record log.
 *
 * Reads `$ARTAGON_COST_LOG` or
 * `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (default
 * `~/.local/state/artagon-agent-cli-plugin/cost.jsonl`).
 *
 * Argv parsing uses `commander` — the canonical Node CLI library —
 * rather than a hand-rolled parser. Standardizes --help, --version,
 * unknown-flag rejection, and option validation, and means we don't
 * own the argv-parsing edge cases.
 *
 * Output (default text):
 *   Total turns: 12 (10 ok, 2 failed)
 *   Total tokens: 12,345 (prompt 6,200 + completion 6,145)
 *   Estimated cost: $0.18
 *   Wall-clock: 87.4s
 *   Window: 2026-05-08T... → 2026-05-08T...
 *
 *   Per backend:
 *     claude     6 turns (5 ok)    7,200 tokens   45.0s
 *     codex      4 turns (4 ok)    4,100 tokens   30.0s
 *     gemini     2 turns (1 ok)    1,045 tokens   12.4s
 *
 * Exit codes:
 *   0  success / under budget
 *   2  usage error (commander auto-handles bad flags here)
 *   3  over budget (--budget / --budget-usd)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import { createAgentContext } from "#lib/agent-context.mjs";
import {
  formatCostSummaryText,
  readCostRecords,
  recentCostRecords,
  summarizeCostRecords
} from "#lib/cost/aggregate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

/**
 * commander's argument-parser hooks: throw InvalidArgumentError to
 * trigger the standard "<value>" not allowed for option message +
 * exit code 1 (which we map to 2 to match the rest of the bin
 * surface — see exitOverride below).
 */

/** @param {string} value */
function parseIso(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError("must be a valid ISO 8601 timestamp");
  }
  return d;
}

/** @param {string} value */
function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return n;
}

/** @param {string} value */
function parsePositiveNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive number");
  }
  return n;
}

const program = new Command();

program
  .name("artagon-stats")
  .description("Print aggregate cost statistics from the local cost-record log")
  .version(PKG.version, "-v, --version")
  .option("--json", "emit the full summary as JSON")
  .option("--since <iso>", "only count records on/after this ISO timestamp", parseIso)
  .option("--until <iso>", "only count records on/before this ISO timestamp", parseIso)
  .option("--recent <n>", "additionally print the N most recent records", parsePositiveInt)
  .option(
    "--budget <n>",
    "exit non-zero (3) if total tokens exceed N (e.g. `artagon-stats --budget 1000000 || alert`)",
    parsePositiveNumber
  )
  .option("--budget-usd <n>", "exit non-zero (3) if estimated USD exceeds N", parsePositiveNumber)
  .option("--cost-log <path>", "override the cost.jsonl path (else ARTAGON_COST_LOG / XDG default)")
  .option("--pricing <path>", "override the pricing table JSON");

// Use exit code 2 for argv errors instead of commander's default 1
// — keeps the existing test contract (status 2 on bad flags).
program.exitOverride((err) => {
  // commander codes:
  //   commander.unknownOption / commander.invalidArgument / commander.missingArgument → 2
  //   commander.helpDisplayed / commander.version → 0 (already handled by commander)
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  process.exit(2);
});

program.parse(process.argv);
const opts = program.opts();

// Build the AgentContext at this boundary. Stats only consults the
// cost slice (logPath / pricingOverride); the other policies stay at
// their defaults. CLI flag wins over env-var fallback — the bin is
// the one place ARTAGON_COST_LOG / ARTAGON_PRICING_OVERRIDE are read
// for back-compat; lib code reads only from context.
const costLogPath = opts.costLog ?? process.env.ARTAGON_COST_LOG;
const pricingOverride = opts.pricing ?? process.env.ARTAGON_PRICING_OVERRIDE;
let context;
try {
  context = createAgentContext({
    env: process.env,
    cost: {
      ...(costLogPath !== undefined && { logPath: costLogPath }),
      ...(pricingOverride !== undefined && { pricingOverride })
    }
  });
} catch (err) {
  process.stderr.write(`artagon-stats: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

// H7: When the daemon's SQLite stats DB exists, merge its rows with
// the JSONL records. The daemon writes both stores; the slash-command
// path writes only JSONL. Reading from both gives a complete picture
// for hybrid deployments where some turns went through the daemon and
// some did not.
let records;
try {
  const jsonl = readCostRecords({
    since: opts.since,
    until: opts.until,
    context
  });
  const { readTurnStats } = await import("#lib/cost/sqlite-recorder.mjs");
  const sqliteRows = readTurnStats({
    env: process.env,
    since: opts.since,
    until: opts.until
  });
  // De-dup by (timestamp, backend, sessionId) — daemon-routed turns
  // appear in BOTH stores. JSONL is the canonical superset for
  // non-daemon turns; SQLite adds traceId / strongly-typed columns
  // for daemon-routed turns. When duplicates exist, the SQLite row
  // takes precedence (it has traceId; JSONL doesn't).
  /** @type {Map<string, import("#lib/cost/aggregate.mjs").CostRecord>} */
  const merged = new Map();
  for (const r of jsonl) {
    merged.set(`${r.timestamp}::${r.backend}::${r.sessionId ?? ""}`, r);
  }
  for (const r of sqliteRows) {
    merged.set(`${r.timestamp}::${r.backend}::${r.sessionId ?? ""}`, r);
  }
  records = Array.from(merged.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`artagon-stats: failed to read cost log: ${message}\n`);
  process.exit(1);
}
const summary = summarizeCostRecords(records);

// Budget gate. Computed up-front so the exit code is set whether
// we render text or JSON. Exit 3 distinguishes "over budget" from
// usage error (2) and clean (0). The render still happens — users
// see WHAT exceeded — and the gate fires after.
let overBudget = false;
let overBudgetMessage = "";
if (typeof opts.budget === "number" && summary.total_tokens > opts.budget) {
  overBudget = true;
  overBudgetMessage = `tokens ${summary.total_tokens.toLocaleString()} exceed budget ${opts.budget.toLocaleString()}`;
}
if (typeof opts.budgetUsd === "number" && summary.estimated_usd > opts.budgetUsd) {
  overBudget = true;
  overBudgetMessage = `estimated $${summary.estimated_usd.toFixed(4)} exceeds budget $${opts.budgetUsd.toFixed(4)}`;
}

if (opts.json) {
  /** @type {any} */
  const out = { summary };
  if (typeof opts.recent === "number") {
    out.recent = recentCostRecords(records, opts.recent);
  }
  if (typeof opts.budget === "number" || typeof opts.budgetUsd === "number") {
    out.budget = {
      tokens: opts.budget ?? null,
      usd: opts.budgetUsd ?? null,
      over: overBudget,
      message: overBudget ? overBudgetMessage : null
    };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(overBudget ? 3 : 0);
}

process.stdout.write(formatCostSummaryText(summary));

// In text mode, default --recent to 5 when not explicitly set so the
// at-a-glance view shows the last few turns alongside totals (matches
// README "text summary + 5 most recent" claim). JSON mode stays
// strictly opt-in — tooling parsing the output shouldn't get an
// unexpected `recent` field. Explicit --recent N (including 0) takes
// precedence over the default.
const TEXT_RECENT_DEFAULT = 5;
const recentCount = typeof opts.recent === "number" ? opts.recent : TEXT_RECENT_DEFAULT;

if (recentCount > 0) {
  const recent = recentCostRecords(records, recentCount);
  if (recent.length > 0) {
    process.stdout.write(`\nRecent (${recent.length}):\n`);
    for (const r of recent) {
      const tokens = (r.usage?.total_tokens ?? 0).toLocaleString();
      const dur = ((r.durationMs ?? 0) / 1000).toFixed(1);
      const status = r.ok ? "ok " : "ERR";
      process.stdout.write(
        `  ${r.timestamp}  ${status}  ${r.backend.padEnd(8)}  ${tokens.padStart(10)} tok  ${dur.padStart(6)}s  ${r.reason ?? ""}\n`
      );
    }
  }
}

if (overBudget) {
  process.stderr.write(`\nOVER BUDGET: ${overBudgetMessage}\n`);
  process.exit(3);
}
