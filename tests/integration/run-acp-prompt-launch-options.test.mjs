/**
 * Integration test: launchOptions forwarded from runAcpPrompt → connectGeminiAcpV2
 * → geminiBackend.transports.cli → buildGeminiArgs → spawned argv.
 *
 * This test patches `geminiBackend.transports.cli` to record the config the
 * runtime hands it. We don't actually spawn the gemini binary — the recorded
 * config is the contract we care about. The argv-emission half is already
 * covered by tests/unit/cli-args-builders.test.mjs; this test ties the two
 * ends together.
 *
 * The runtime takes the broker path when a broker is available, which would
 * skip the CLI factory entirely. We force the CLI path by setting
 * `disableBroker` semantics — no broker session file in cwd, no
 * GEMINI_COMPANION_ACP_ENDPOINT in env.
 */

import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { geminiBackend } from "#lib/backends/gemini.mjs";
import { runAcpPrompt } from "../../plugins/gemini/scripts/lib/gemini.mjs";

const MOCK_PATH = path.resolve(new URL("../mocks/gemini-mock.mjs", import.meta.url).pathname);

/** @type {((config?: any) => any) | null} */
let savedCli = null;
/** @type {Record<string, string | undefined>} */
let savedEnv = {};

beforeEach(() => {
  // Spy on the cli factory: record the config it sees, then delegate to a
  // factory that points at the mock binary so the test still completes.
  savedCli = geminiBackend.transports.cli;
  // Strip the broker endpoint env var so connectGeminiAcpV2 takes the CLI
  // path (otherwise it tries the broker socket, which the mock doesn't
  // implement).
  savedEnv = {
    GEMINI_COMPANION_ACP_ENDPOINT: process.env.GEMINI_COMPANION_ACP_ENDPOINT
  };
  Reflect.deleteProperty(process.env, "GEMINI_COMPANION_ACP_ENDPOINT");
});

afterEach(() => {
  if (savedCli) geminiBackend.transports.cli = savedCli;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

/** Spawn-recording cli factory that runs the mock instead of real gemini. */
function installSpy(/** @type {{ recorded?: any }} */ recorder) {
  geminiBackend.transports.cli = (config = {}) => {
    recorder.recorded = config;
    return /** @type {any} */ (savedCli)({
      cwd: config.cwd,
      env: config.env,
      command: process.execPath,
      args: [MOCK_PATH, "--acp"]
    });
  };
}

test("runAcpPrompt without launchOptions: cli factory sees only cwd + env", async () => {
  /** @type {{ recorded?: any }} */
  const recorder = {};
  installSpy(recorder);
  // Mock doesn't implement session/* — runAcpPrompt's internal session
  // requests will reject, but that's fine for this assertion which only
  // cares about the launch-time config.
  await runAcpPrompt(process.cwd(), "ignored", {
    env: {},
    sessionId: "sid",
    disableBroker: true
  });
  expect(recorder.recorded).toBeDefined();
  expect(Object.keys(recorder.recorded ?? {})).toEqual(expect.arrayContaining(["cwd", "env"]));
  expect(recorder.recorded.yolo).toBeUndefined();
  expect(recorder.recorded.approvalMode).toBeUndefined();
  expect(recorder.recorded.worktree).toBeUndefined();
});

test("runAcpPrompt with launchOptions: forwards yolo + worktree + policyFiles", async () => {
  /** @type {{ recorded?: any }} */
  const recorder = {};
  installSpy(recorder);
  await runAcpPrompt(process.cwd(), "ignored", {
    env: {},
    sessionId: "sid",
    disableBroker: true,
    launchOptions: {
      yolo: true,
      worktree: "review-branch",
      policyFiles: ["./policies/main.md"]
    }
  });
  expect(recorder.recorded.yolo).toBe(true);
  expect(recorder.recorded.worktree).toBe("review-branch");
  expect(recorder.recorded.policyFiles).toEqual(["./policies/main.md"]);
  // env + cwd are still forwarded alongside.
  expect(recorder.recorded.cwd).toBe(process.cwd());
});

test("launchOptions cannot override cwd or env (outer args always win)", async () => {
  /** @type {{ recorded?: any }} */
  const recorder = {};
  installSpy(recorder);
  const customEnv = { CUSTOM: "1" };
  // Cast to any so the typedef doesn't reject the deliberately-bad cwd/env
  // in launchOptions. The test exists precisely to verify these are silently
  // overridden by the outer arguments at the merge boundary.
  /** @type {any} */
  const sneaky = {
    cwd: "/should-not-be-honored",
    env: { SNEAKY: "yes" },
    yolo: true
  };
  await runAcpPrompt(process.cwd(), "ignored", {
    env: customEnv,
    sessionId: "sid",
    disableBroker: true,
    launchOptions: sneaky
  });
  expect(recorder.recorded.cwd).toBe(process.cwd());
  expect(recorder.recorded.env).toBe(customEnv);
  expect(recorder.recorded.yolo).toBe(true);
});
