#!/usr/bin/env node
/**
 * Entry script for `/claude:stats` (installed in Claude Code).
 *
 * Surfaces the same summary that `bin/artagon-stats` exposes from the
 * shell — total turns, tokens, wall-clock, per-backend breakdown — but
 * called from inside the host's slash-command surface so users don't
 * need to drop to a terminal.
 *
 * Argv passes through to the underlying flag parser (subset):
 *   --json            emit JSON instead of text
 *   --recent <n>      include the n most recent turns (default 5)
 *   --since <iso>     only records on/after this ISO timestamp
 *   --until <iso>     only records on/before this ISO timestamp
 *
 * On no records at all, prints a friendly message and exits 0.
 */

import process from "node:process";

import {
  formatCostSummaryText,
  readCostRecords,
  recentCostRecords,
  summarizeCostRecords
} from "#lib/cost/aggregate.mjs";

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ json?: boolean, recent: number, since?: Date, until?: Date }} */
  const out = { recent: 5 };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--json") out.json = true;
    else if (tok === "--recent") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --recent: ${argv[i]}`);
      out.recent = n;
    } else if (tok === "--since") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --since: ${argv[i]}`);
      out.since = d;
    } else if (tok === "--until") {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid --until: ${argv[i]}`);
      out.until = d;
    }
    // Silently ignore other tokens — the slash-command shell may pass
    // a free-form prompt that we don't need; flags are opt-in.
  }
  return out;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`stats: ${/** @type {Error} */ (err).message}\n`);
  process.exit(2);
}

const records = readCostRecords({ since: opts.since, until: opts.until });
const summary = summarizeCostRecords(records);

if (opts.json) {
  const recent = opts.recent > 0 ? recentCostRecords(records, opts.recent) : [];
  process.stdout.write(`${JSON.stringify({ summary, recent }, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(formatCostSummaryText(summary));
if (opts.recent > 0) {
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
process.exit(0);
