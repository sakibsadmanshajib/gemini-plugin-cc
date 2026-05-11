#!/usr/bin/env node
/**
 * Entry script for `/claude:prompt` (installed in Codex CLI).
 *
 * Boundary: argv + env are read here exactly once to construct an
 * `AgentContext`. Lib code downstream reads from the context, not
 * from process.env.
 *
 * Run `node claude-prompt.mjs --help` for the full flag list.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runSlashCommandScript } from "#lib/cli/script-entry.mjs";

await runSlashCommandScript({
  backend: BACKEND_NAMES.CLAUDE,
  scriptName: "claude-prompt"
});
