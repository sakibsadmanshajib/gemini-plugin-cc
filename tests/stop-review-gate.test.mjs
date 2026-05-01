/**
 * Stop-review-gate hook — execution semantics.
 *
 * Round-1 swarm review (Copilot, Codex, Gemini all converged) flipped the
 * non-ENOENT failure mode from fail-OPEN to fail-CLOSED. The pre-existing
 * `commands.test.mjs:140` only asserts the hook script is referenced from
 * `hooks/hooks.json` — it does NOT exercise the failure semantic. Round-2
 * Gemini flagged this as a security-relevant gate's behavior pivot
 * shipping with no execution test.
 *
 * What this file pins:
 *   1. Non-zero exit from `gemini` → hook emits a `block` decision (fail
 *      CLOSED) with a reason that surfaces the failure to the user.
 *   2. ENOENT (binary missing) → hook stays silent (fail OPEN), so a
 *      missing CLI on the hook's inherited PATH does not lock the user
 *      into a review-failed loop.
 *
 * Implementation strategy:
 *   - Run the hook as a subprocess via `node <hook-path>`.
 *   - Stage a controlled state dir + workspace via the same env shape
 *     the runtime uses (CLAUDE_PLUGIN_DATA + CLAUDE_ENV_FILE → Claude;
 *     unset → Codex). We use Codex shape (no env) for a deterministic
 *     fallback under TMPDIR.
 *   - Pre-write `state.json` with `{ config: { stopReviewGate: true } }`
 *     under the workspace's resolved state dir, so the gate fires.
 *   - Stage a `gemini` shim on PATH whose behavior we control per test:
 *     fail-non-zero variant (asserts BLOCK), and absent-from-PATH variant
 *     (asserts silent allow).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  PLUGIN_ROOT,
  PLUGIN_SOURCE_DIR_RELATIVE,
  CLAUDE_HOST_SIGNAL_ENV,
  CLAUDE_PLUGIN_DATA_ENV
} from "./install-paths.mjs";

const HOOK_SCRIPT = path.join(
  PLUGIN_ROOT,
  PLUGIN_SOURCE_DIR_RELATIVE,
  "scripts",
  "stop-review-gate-hook.mjs"
);
const STATE_LIB_PATH = path.join(
  PLUGIN_ROOT,
  PLUGIN_SOURCE_DIR_RELATIVE,
  "scripts",
  "lib",
  "state.mjs"
);

function initGitRepo(cwd) {
  spawnSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd, stdio: "ignore" });
}

/**
 * Build a fresh workspace + write the gate-enabled state.json so the hook
 * actually invokes `gemini`. Returns paths and a cleanup function. Forces
 * Codex env shape (CLAUDE_ENV_FILE + CLAUDE_PLUGIN_DATA absent) so the
 * runtime resolves state dir under TMPDIR deterministically.
 */
async function setupWorkspaceWithGateEnabled() {
  delete process.env[CLAUDE_HOST_SIGNAL_ENV];
  delete process.env[CLAUDE_PLUGIN_DATA_ENV];

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-stop-review-"));
  initGitRepo(workspace);

  const { resolveStateDir, resolveStateFile, ensureStateDir } = await import(STATE_LIB_PATH);
  ensureStateDir(workspace);

  const state = {
    version: 1,
    config: { stopReviewGate: true },
    jobs: []
  };
  fs.writeFileSync(resolveStateFile(workspace), JSON.stringify(state, null, 2), "utf8");

  return {
    workspace,
    stateDir: resolveStateDir(workspace),
    cleanup: () => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(resolveStateDir(workspace), { recursive: true, force: true });
    }
  };
}

/**
 * Stage a temp dir with a `gemini` shim that always exits non-zero with a
 * stderr message. Returns a PATH override containing only this dir, so the
 * test does NOT see any real `gemini` binary the developer happens to have
 * installed locally.
 */
function stageFailingGeminiShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-shim-fail-"));
  const shimPath = path.join(shimDir, "gemini");
  fs.writeFileSync(shimPath, "#!/bin/sh\necho 'shim: simulated failure' >&2\nexit 17\n", {
    mode: 0o755
  });
  return {
    shimDir,
    pathOverride: shimDir,
    cleanup: () => fs.rmSync(shimDir, { recursive: true, force: true })
  };
}

/**
 * PATH that contains essentials (node, git) but NO `gemini` binary.
 *
 * We can't pass an empty PATH or rely on hard-coded /usr/bin — node lives
 * at /opt/homebrew/bin on macOS dev installs and at varying paths on CI.
 * Strategy: take the developer's PATH, drop any directory that contains
 * a `gemini` binary, keep the rest. That guarantees the hook can find
 * `node` (the hook script may shell out to other helpers) and `git`,
 * while the `gemini` shim absence/presence is fully test-controlled.
 */
function pathWithoutGemini() {
  const inherited = (process.env.PATH ?? "").split(":").filter(Boolean);
  return inherited
    .filter((dir) => !fs.existsSync(path.join(dir, "gemini")))
    .join(":");
}

test("stop-review-gate-hook: fails CLOSED on non-zero gemini exit (emits block decision)", async () => {
  const fixture = await setupWorkspaceWithGateEnabled();
  const shim = stageFailingGeminiShim();

  const hookInput = JSON.stringify({
    cwd: fixture.workspace,
    stopHookInput: { claudeResponse: "I changed src/foo.js to do X." }
  });

  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: fixture.workspace,
    input: hookInput,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: shim.pathOverride + ":" + pathWithoutGemini(),
      CLAUDE_PROJECT_DIR: fixture.workspace,
      CLAUDE_ENV_FILE: "",
      CLAUDE_PLUGIN_DATA: ""
    },
    timeout: 15_000
  });

  // The hook itself should exit cleanly (hooks must not crash Claude).
  assert.equal(result.status, 0,
    `hook exited non-zero: stderr=${result.stderr} stdout=${result.stdout}`);

  // stdout should contain a JSON decision with `decision: "block"`.
  const stdout = (result.stdout ?? "").trim();
  assert.ok(stdout.length > 0,
    `expected hook to emit a block decision JSON to stdout when gemini fails; got empty stdout. stderr=${result.stderr}`);

  let decision;
  try {
    decision = JSON.parse(stdout.split("\n").pop());
  } catch (err) {
    assert.fail(`hook stdout was not valid JSON: ${stdout} (${err.message})`);
  }

  assert.equal(decision.decision, "block",
    `expected fail-CLOSED on non-zero gemini exit; got decision=${JSON.stringify(decision)}`);
  assert.match(decision.reason, /Gemini review failed/i,
    `block reason should surface the failure cause; got: ${decision.reason}`);

  fixture.cleanup();
  shim.cleanup();
});

test("stop-review-gate-hook: fails OPEN on ENOENT (gemini binary missing)", async () => {
  const fixture = await setupWorkspaceWithGateEnabled();

  const hookInput = JSON.stringify({
    cwd: fixture.workspace,
    stopHookInput: { claudeResponse: "I changed src/foo.js to do X." }
  });

  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: fixture.workspace,
    input: hookInput,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathWithoutGemini(),
      CLAUDE_PROJECT_DIR: fixture.workspace,
      CLAUDE_ENV_FILE: "",
      CLAUDE_PLUGIN_DATA: ""
    },
    timeout: 15_000
  });

  assert.equal(result.status, 0,
    `hook exited non-zero: stderr=${result.stderr} stdout=${result.stdout}`);

  // ENOENT path: hook should NOT emit a block decision. stdout is either
  // empty or contains no `"decision":"block"` payload.
  const stdout = (result.stdout ?? "").trim();
  if (stdout.length > 0) {
    let decision;
    try {
      decision = JSON.parse(stdout.split("\n").pop());
    } catch {
      // Non-JSON output is fine — hook only emits JSON on block.
      decision = null;
    }
    if (decision) {
      assert.notEqual(decision.decision, "block",
        `expected fail-OPEN on ENOENT (binary missing); got block decision: ${JSON.stringify(decision)}`);
    }
  }

  // Per Copilot review on artagon PR #1: when the gate is toggled on but
  // `gemini` is missing from PATH, the user MUST see WHY review didn't run.
  // The hook surfaces this via two complementary paths:
  //   1. `buildSetupNote()` (the precheck) — fires when the binary is
  //      missing from PATH at hook entry; emits "Gemini CLI is not
  //      installed. Run /gemini:setup to install." on stderr.
  //   2. `runStopReview` ENOENT branch — fires for races where the
  //      precheck saw the binary but the actual spawn lost it; emits
  //      "Stop-review skipped: `gemini` CLI not on PATH..." on stderr.
  // In real environments missing-from-PATH lands on path 1; the runStopReview
  // ENOENT branch is a defensive safety net for the racy case.
  const stderr = result.stderr ?? "";
  assert.match(stderr, /(Gemini CLI is not installed|Stop-review skipped.*gemini.*PATH)/i,
    `Missing-binary skip reason must surface on stderr (either via setupNote or runStopReview ENOENT branch); got stderr=${JSON.stringify(stderr)}`);

  fixture.cleanup();
});
