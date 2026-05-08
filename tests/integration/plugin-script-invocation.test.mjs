/**
 * End-to-end "does the script even start" tests for all six
 * cross-pollination entry scripts.
 *
 * These tests spawn each script with no args and verify:
 *   - exit code 2 (the documented "missing prompt" exit code)
 *   - stderr contains the "usage" message
 *   - no stdout (no accidental log leakage onto the wire)
 *
 * The point isn't to test argv parsing in detail — that's covered by
 * the per-runner unit tests. The point is to verify the IMPORT GRAPH
 * loads cleanly:
 *   - subpath imports (`#lib/...`) resolve
 *   - the dispatcher + runners + translators all initialize
 *   - no top-level throws from missing exports or circular deps
 *
 * If any plugin script's import chain breaks, these tests fail fast
 * with an exit code other than 2 (typically 1 for an uncaught import
 * error).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

/**
 * Spawn a plugin entry script with NO args and capture exit/stdout/stderr.
 *
 * @param {string} relPath
 */
function runScriptNoArgs(relPath) {
  return spawnSync(process.execPath, [path.join(ROOT, relPath)], {
    cwd: ROOT,
    timeout: 10000
  });
}

const scripts = [
  // host=claude, drives the OTHER two
  "plugins/claude/scripts/codex-prompt.mjs",
  "plugins/claude/scripts/gemini-prompt.mjs",
  // host=codex, drives the OTHER two
  "plugins/codex/scripts/claude-prompt.mjs",
  "plugins/codex/scripts/gemini-prompt.mjs",
  // host=gemini, drives the OTHER two
  "plugins/gemini/scripts/claude-prompt.mjs",
  "plugins/gemini/scripts/codex-prompt.mjs"
];

describe("plugin entry script invocation (smoke)", () => {
  for (const relPath of scripts) {
    test(`${relPath}: no args → exit 2 + stderr usage + clean import graph`, () => {
      const result = runScriptNoArgs(relPath);

      expect(result.error).toBeUndefined(); // no spawn error
      // Exit code 2 is the documented "missing prompt" path. Anything else
      // (1 = thrown error, null = killed, etc.) means the import graph
      // failed before argv parsing.
      expect(result.status).toBe(2);

      const stderr = result.stderr.toString();
      expect(stderr).toMatch(/usage/i);
      // Each script's name should appear in its own usage message so
      // users know which one rejected.
      const scriptName = path.basename(relPath, ".mjs");
      expect(stderr.toLowerCase()).toContain(scriptName);

      // Critical: no stdout. The cross-pollination scripts only write
      // structured output on success; a stderr-only failure must keep
      // stdout untouched (otherwise it pollutes any consumer parsing
      // the script's output).
      expect(result.stdout.toString()).toBe("");
    });
  }
});
