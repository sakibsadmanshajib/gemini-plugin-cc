#!/usr/bin/env node
/**
 * `artagon-agent` — CLI entry point for the multi-backend ACP plugin suite.
 *
 * Usage:
 *   artagon-agent <backend> "<prompt>" [flags]
 *
 *   <backend>   one of: claude, codex, gemini
 *   <prompt>    the natural-language prompt; quote it
 *
 * Wraps `runStatelessTurn(BACKEND_NAMES.<X>, options)` from
 * `lib/runners/dispatch.mjs`. Argv parsing uses commander — the
 * canonical Node CLI library — instead of a hand-rolled parser.
 *
 * Exit codes:
 *   0  success
 *   1  runtime error (spawn failed, CLI exited non-zero, abort, etc.)
 *   2  usage error (missing/invalid args)
 *
 * Run via:
 *   npx artagon-agent-cli-plugin <backend> "..."
 *   pnpm exec artagon-agent <backend> "..."
 *   (after `npm i -g artagon-agent-cli-plugin`) artagon-agent <backend> "..."
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import { ALL_BACKEND_NAMES, isBackendName } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

/** @param {string} value */
function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

/** @param {string} value */
function parseBackend(value) {
  if (!isBackendName(value)) {
    throw new InvalidArgumentError(`must be one of ${ALL_BACKEND_NAMES.join(", ")}`);
  }
  return value;
}

const program = new Command();

program
  .name("artagon-agent")
  .description("Run a stateless one-shot turn against a backend (claude / codex / gemini)")
  .version(PKG.version, "-v, --version")
  .argument("<backend>", `backend (${ALL_BACKEND_NAMES.join(", ")})`, parseBackend)
  .argument("<prompt...>", "natural-language prompt; quote it (or pass multiple words unquoted)")
  .option("--model <id>", "per-invocation model id passed through to the runner")
  .option(
    "--timeout-ms <n>",
    `defensive timeout (default ${5 * 60 * 1000} = 5 min)`,
    parsePositiveInt
  )
  .option("--cwd <path>", "working dir for the spawned CLI")
  .option("--json", "emit the full TurnResult as JSON instead of formatted text");

program.exitOverride((err) => {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  process.exit(2);
});

program.parse(process.argv);
const opts = program.opts();
const [backend, ...promptParts] = program.args;
const prompt = promptParts.join(" ");

if (!prompt) {
  process.stderr.write("artagon-agent: prompt is required\n");
  program.outputHelp({ error: true });
  process.exit(2);
}

// Plumb SIGINT/SIGTERM into an AbortController so a Ctrl-C cleanly
// cancels the in-flight backend turn (each runner SIGTERMs its child
// + rejects with the abort reason on signal.aborted). Without this,
// cancellation relies entirely on shell process-group signal propagation,
// which is fragile — e.g., if the backend CLI sets its own process group
// or briefly ignores SIGINT during cleanup, the child can outlive the
// parent.
const ac = new AbortController();
const abortOnSignal = (/** @type {string} */ sig) => {
  process.stderr.write(`\nartagon-agent: ${sig} received, aborting backend turn...\n`);
  ac.abort(new Error(`aborted (${sig})`));
};
process.on("SIGINT", () => abortOnSignal("SIGINT"));
process.on("SIGTERM", () => abortOnSignal("SIGTERM"));

try {
  const turn = await runStatelessTurn(backend, {
    prompt,
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    model: opts.model,
    timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
    signal: ac.signal
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(turn, null, 2)}\n`);
  } else {
    process.stdout.write(turn.text);
    if (turn.toolCalls.length > 0) {
      process.stdout.write(
        `\n\n— ${turn.toolCalls.length} tool call(s) ` +
          `(${turn.toolCalls.map((t) => t.toolName).join(", ")})\n`
      );
    }
    if (turn.usage) process.stdout.write(`— usage: ${JSON.stringify(turn.usage)}\n`);
  }
} catch (err) {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "exitCode" in err
        ? `${backend} exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
        : String(err);
  process.stderr.write(`artagon-agent: ${message}\n`);
  process.exit(1);
}
