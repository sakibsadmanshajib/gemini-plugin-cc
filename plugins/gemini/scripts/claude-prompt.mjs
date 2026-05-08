#!/usr/bin/env node
/**
 * Entry script for `/claude:prompt` (installed in a Gemini host).
 *
 * Mirror of `plugins/codex/scripts/claude-prompt.mjs` and
 * `plugins/claude/...` siblings — same shape, same dispatcher, same
 * formatted-output convention. Only the install host differs.
 *
 * Cross-pollination invariant: this script lives in `plugins/gemini/`
 * (host = gemini) but MUST drive Claude (the OTHER backend), never
 * Gemini itself. Asserted by tests/unit/multi-plugin-scaffold.test.mjs.
 */

import process from "node:process";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  process.stderr.write(
    "claude-prompt: usage: /claude:prompt <prompt>\n" +
      "(prompt was empty after argv concatenation)\n"
  );
  process.exit(2);
}

try {
  const turn = await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt,
    cwd: process.cwd(),
    env: process.env,
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
        ? `claude exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
        : String(err);
  process.stderr.write(`claude-prompt error: ${message}\n`);
  process.exit(1);
}
