#!/usr/bin/env node
/**
 * `artagon-stats` — print aggregate cost statistics from the local
 * cost-record log.
 *
 * Reads `$ARTAGON_COST_LOG` or
 * `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (default
 * `~/.local/state/artagon-agent-cli-plugin/cost.jsonl`).
 *
 * Usage:
 *   artagon-stats [flags]
 *
 *   --json             emit the full summary as JSON
 *   --since <iso>      only count records on/after this ISO timestamp
 *   --until <iso>      only count records on/before this ISO timestamp
 *   --recent <n>       additionally print the N most recent records
 *   --version          print version + exit
 *   --help             print this message
 *
 * Output (default text):
 *   Total turns: 12 (10 ok, 2 failed)
 *   Total tokens: 12,345 (prompt 6,200 + completion 6,145)
 *   Wall-clock: 87.4s
 *   Window: 2026-05-08T... → 2026-05-08T...
 *
 *   Per backend:
 *     claude     6 turns (5 ok)    7,200 tokens   45.0s
 *     codex      4 turns (4 ok)    4,100 tokens   30.0s
 *     gemini     2 turns (1 ok)    1,045 tokens   12.4s
 *
 * Exit codes:
 *   0  success
 *   2  usage error
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  formatCostSummaryText,
  readCostRecords,
  recentCostRecords,
  summarizeCostRecords
} from "#lib/cost/aggregate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const USAGE = `artagon-stats [flags]

flags:
  --json             emit the full summary as JSON
  --since <iso>      only count records on/after this ISO timestamp
  --until <iso>      only count records on/before this ISO timestamp
  --recent <n>       additionally print the N most recent records
  --budget <n>       exit non-zero (3) if total tokens exceed N
                     (useful in CI: \`artagon-stats --budget 1000000 || alert\`)
  --budget-usd <n>   exit non-zero (3) if estimated USD exceeds N
  --version          print version
  --help             print this message
`;

function printUsage(stream = process.stderr) {
  stream.write(USAGE);
}

function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ json?: boolean, since?: Date, until?: Date, recent?: number, budget?: number, budgetUsd?: number, version?: boolean, help?: boolean }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") out.help = true;
    else if (tok === "--version" || tok === "-v") out.version = true;
    else if (tok === "--json") out.json = true;
    else if (tok === "--since") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --since: ${argv[i]}`);
      out.since = d;
    } else if (tok === "--until") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --until: ${argv[i]}`);
      out.until = d;
    } else if (tok === "--recent") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --recent: ${argv[i]}`);
      out.recent = n;
    } else if (tok === "--budget") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --budget: ${argv[i]}`);
      out.budget = n;
    } else if (tok === "--budget-usd") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --budget-usd: ${argv[i]}`);
      out.budgetUsd = n;
    } else {
      throw new Error(`unknown flag: ${tok}`);
    }
  }
  return out;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`artagon-stats: ${/** @type {Error} */ (err).message}\n\n`);
  printUsage();
  process.exit(2);
}

if (opts.version) {
  process.stdout.write(`${PKG.version}\n`);
  process.exit(0);
}
if (opts.help) {
  printUsage(process.stdout);
  process.exit(0);
}

const records = readCostRecords({ since: opts.since, until: opts.until });
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

if (typeof opts.recent === "number" && opts.recent > 0) {
  const recent = recentCostRecords(records, opts.recent);
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
