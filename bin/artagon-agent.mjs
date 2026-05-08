#!/usr/bin/env node
/**
 * `artagon-agent` — CLI entry point for the multi-backend ACP plugin suite.
 *
 * Usage:
 *   artagon-agent <backend> "<prompt>" [flags]
 *
 *   <backend>   one of: claude, codex, gemini
 *   <prompt>    the natural-language prompt; quote it
 *   --model <id>          per-invocation model (passed through to the runner)
 *   --timeout-ms <n>      defensive timeout (default 5 min)
 *   --cwd <path>          working dir for the spawned CLI
 *   --json                emit the full TurnResult as JSON instead of formatted text
 *   --version             print the package version and exit
 *   --help                print this message and exit
 *
 * Wraps `runStatelessTurn(BACKEND_NAMES.<X>, options)` from
 * `lib/runners/dispatch.mjs`. Exit codes:
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

import { ALL_BACKEND_NAMES, isBackendName } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const USAGE = `artagon-agent <backend> "<prompt>" [flags]

backends:    ${ALL_BACKEND_NAMES.join(", ")}

flags:
  --model <id>          per-invocation model
  --timeout-ms <n>      defensive timeout (default ${5 * 60 * 1000} = 5 min)
  --cwd <path>          working dir for the spawned CLI
  --json                emit the full TurnResult as JSON
  --version             print version
  --help                print this message
`;

function printUsage(stream = process.stderr) {
  stream.write(USAGE);
}

function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ backend?: string, prompt?: string, model?: string, timeoutMs?: number, cwd?: string, json?: boolean, version?: boolean, help?: boolean }} */
  const out = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") out.help = true;
    else if (tok === "--version" || tok === "-v") out.version = true;
    else if (tok === "--json") out.json = true;
    else if (tok === "--model") out.model = argv[++i];
    else if (tok === "--cwd") out.cwd = argv[++i];
    else if (tok === "--timeout-ms") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --timeout-ms: ${argv[i]}`);
      out.timeoutMs = n;
    } else if (tok.startsWith("--")) {
      throw new Error(`unknown flag: ${tok}`);
    } else {
      positional.push(tok);
    }
  }
  if (positional.length >= 1) out.backend = positional[0];
  if (positional.length >= 2) out.prompt = positional.slice(1).join(" ");
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`artagon-agent: ${/** @type {Error} */ (err).message}\n\n`);
    printUsage();
    process.exit(2);
  }

  if (opts.version) {
    process.stdout.write(`${PKG.version}\n`);
    return;
  }
  if (opts.help || !opts.backend) {
    printUsage(opts.help ? process.stdout : process.stderr);
    process.exit(opts.help ? 0 : 2);
  }

  if (!isBackendName(opts.backend)) {
    process.stderr.write(
      `artagon-agent: unknown backend "${opts.backend}" — must be one of ${ALL_BACKEND_NAMES.join(", ")}\n`
    );
    process.exit(2);
  }
  if (!opts.prompt) {
    process.stderr.write("artagon-agent: prompt is required\n\n");
    printUsage();
    process.exit(2);
  }

  try {
    const turn = await runStatelessTurn(opts.backend, {
      prompt: opts.prompt,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000
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
          ? `${opts.backend} exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
          : String(err);
    process.stderr.write(`artagon-agent: ${message}\n`);
    process.exit(1);
  }
}

await main();
