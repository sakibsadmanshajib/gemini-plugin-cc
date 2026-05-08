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
  .option("--budget-usd <n>", "exit non-zero (3) if estimated USD exceeds N", parsePositiveNumber);

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

// readCostRecords swallows per-line JSON parse failures (log
// corruption is recoverable) but throws on file-level errors —
// EACCES from wrong perms, EISDIR from a path collision, etc.
// Catch those and print a one-liner instead of dumping a raw Node
// stack at the user. Exit 1 (runtime error), not 2 (usage error)
// — the args were fine, the environment is misconfigured.
let records;
try {
  records = readCostRecords({ since: opts.since, until: opts.until });
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
