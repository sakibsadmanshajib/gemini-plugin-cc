#!/usr/bin/env node
/**
 * Entry script for `/codex:prompt` (installed in Claude Code).
 *
 * Reads the prompt from argv (joined with spaces), dispatches to the
 * Codex stateless runner via `runStatelessTurn(BACKEND_NAMES.CODEX, ...)`,
 * prints the accumulated text + tool call summary on stdout, exits 0
 * on success or non-zero with the error written to stderr.
 *
 * No ACP, no broker, no shared subprocess state — just a one-shot
 * `codex exec --json` invocation, translated into ACP-shape updates,
 * accumulated into a TurnResult, summarized.
 */

import process from "node:process";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  process.stderr.write(
    "codex-prompt: usage: /codex:prompt <prompt>\n" +
      "(prompt was empty after argv concatenation)\n"
  );
  process.exit(2);
}

try {
  const turn = await runStatelessTurn(BACKEND_NAMES.CODEX, {
    prompt,
    cwd: process.cwd(),
    env: process.env,
    // 5 min ceiling — caller can override later via env, but a sane
    // default keeps a hung CLI from blocking the host's session.
    timeoutMs: 5 * 60 * 1000
  });

  process.stdout.write(turn.text);
  if (turn.toolCalls.length > 0) {
    process.stdout.write(
      `\n\n— ${turn.toolCalls.length} tool call(s) ` +
        `(${turn.toolCalls.map((t) => t.toolName).join(", ")})\n`
    );
  }
  if (turn.usage) {
    process.stdout.write(`— usage: ${JSON.stringify(turn.usage)}\n`);
  }
  process.exit(0);
} catch (err) {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "exitCode" in err
        ? `codex exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
        : String(err);
  process.stderr.write(`codex-prompt error: ${message}\n`);
  process.exit(1);
}
