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
 * Wraps `runStatelessTurn(BACKEND_NAMES.<X>, options, context)` from
 * `lib/runners/dispatch.mjs`. Commander parses the positional + flags;
 * the resulting `AgentContext` is built once at this boundary and
 * threaded through `lib/`.
 *
 * Exit codes:
 *   0  success
 *   1  runtime error (spawn failed, CLI exited non-zero, abort, etc.)
 *   2  usage error (missing/invalid args)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import { createAgentContext } from "#lib/agent-context.mjs";
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

/**
 * @param {string} value
 * @returns {import("#lib/backends/names.mjs").BackendName}
 */
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
  // ── per-turn ──
  .option("--model <id>", "per-invocation model id passed through to the runner")
  .option(
    "--timeout-ms <n>",
    `defensive timeout (default ${5 * 60 * 1000} = 5 min)`,
    parsePositiveInt
  )
  .option("--cwd <path>", "working dir for the spawned CLI")
  .option("--json", "emit the full TurnResult as JSON instead of formatted text")
  // ── dispatch (tri-state via paired flags; commander synthesizes --no-*) ──
  .option("--streaming", "route via the streaming warm-path runner")
  .option("--no-streaming", "veto the streaming runner")
  .option("--facade", "route via the OpenAI facade")
  .option("--no-facade", "veto the facade")
  .option("--no-broker", "gemini: skip the legacy broker probe")
  // ── observability ──
  .option("--wire-log <path>", "capture every JSON-RPC frame to <path>")
  .option("--wire-log-raw", "disable secret redaction in wire log")
  .option("--trace-id <id>", "correlation id surfaced to wire log + cost record")
  // ── cost ──
  .option("--cost-log <path>", "override cost.jsonl path")
  .option("--no-cost-log", "suppress cost recording for this invocation")
  .option("--pricing <path>", "override pricing table JSON")
  // ── facade ──
  .option("--facade-key <token>", "bearer token for the OpenAI facade")
  // ── diagnostics ──
  .option("--debug", "enable verbose diagnostics");

program.exitOverride((err) => {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  process.exit(2);
});

program.parse(process.argv);
const opts = program.opts();
const [rawBackend, ...promptParts] = program.args;
const backend = /** @type {import("#lib/backends/names.mjs").BackendName} */ (rawBackend);
const prompt = promptParts.join(" ");

if (!prompt) {
  process.stderr.write("artagon-agent: prompt is required\n");
  program.outputHelp({ error: true });
  process.exit(2);
}

// Commander uses opts.streaming / opts.noStreaming pairs (camelCase
// inference). Translate to the AgentContext tri-state shape.
/** @type {"on" | "off" | "default"} */
const streaming = opts.streaming === true ? "on" : opts.streaming === false ? "off" : "default";
/** @type {"on" | "off" | "default"} */
const facade = opts.facade === true ? "on" : opts.facade === false ? "off" : "default";

let context;
try {
  context = createAgentContext({
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    dispatch: {
      streaming,
      facade,
      broker: opts.broker === false ? "disabled" : "auto"
    },
    logging: {
      ...(opts.wireLog !== undefined && { wireLogPath: opts.wireLog }),
      ...(opts.wireLogRaw === true && { wireLogRaw: true }),
      ...(opts.traceId !== undefined && { traceId: opts.traceId })
    },
    cost: {
      ...(opts.costLog === false && { disabled: true }),
      ...(opts.costLog !== undefined && opts.costLog !== false && { logPath: opts.costLog }),
      ...(opts.pricing !== undefined && { pricingOverride: opts.pricing })
    },
    facade: {
      ...(opts.facadeKey !== undefined && { apiKey: opts.facadeKey })
    },
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    debug: opts.debug === true ? true : undefined
  });
} catch (err) {
  process.stderr.write(`artagon-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

// SIGINT/SIGTERM → AbortController so Ctrl-C cancels the in-flight
// backend turn. Each runner SIGTERMs its child and rejects with the
// abort reason on signal.aborted.
const ac = new AbortController();
const abortOnSignal = (/** @type {string} */ sig) => {
  process.stderr.write(`\nartagon-agent: ${sig} received, aborting backend turn...\n`);
  ac.abort(new Error(`aborted (${sig})`));
};
process.on("SIGINT", () => abortOnSignal("SIGINT"));
process.on("SIGTERM", () => abortOnSignal("SIGTERM"));

try {
  const turn = await runStatelessTurn(
    backend,
    {
      prompt,
      cwd: context.cwd,
      env: context.env,
      model: context.model,
      timeoutMs: context.timeoutMs ?? 5 * 60 * 1000,
      signal: ac.signal
    },
    context
  );

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
