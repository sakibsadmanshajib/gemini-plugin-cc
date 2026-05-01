/**
 * broker-lifecycle.ensureBrokerSession — integrated decision tree.
 *
 * The reaper's 4 branches are covered by `broker-reaper.test.mjs`. This file
 * covers the function the reaper unblocks: `ensureBrokerSession`. After the
 * round-1 swarm review, staleness + liveness checks are folded INTO
 * `ensureBrokerSession` (no separate `reapStaleBroker` call) so there's
 * exactly ONE liveness probe per decision. This file pins that invariant.
 *
 * Decision tree:
 *   1. No session file        → spawn new broker (returns session info or null on timeout)
 *   2. Live endpoint          → return existing (probe count = 1)
 *   3. Dead endpoint          → tear down + spawn new broker
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  PLUGIN_ROOT,
  PLUGIN_SOURCE_DIR_RELATIVE,
  CLAUDE_HOST_SIGNAL_ENV,
  CLAUDE_PLUGIN_DATA_ENV,
  ACP_SESSION_DIR_NAME,
  BROKER_PID_FILENAME,
  BROKER_LOG_FILENAME,
  BROKER_SESSION_FILENAME
} from "./install-paths.mjs";

const LIB_DIR = path.join(PLUGIN_ROOT, PLUGIN_SOURCE_DIR_RELATIVE, "scripts", "lib");

function initGitRepo(cwd) {
  spawnSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd, stdio: "ignore" });
}

function startFakeListener(socketPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.end());
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function stopFakeListener(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Set up a fake workspace + a `broker-session.json` pointing at a Unix socket
 * that may or may not have a listener bound.
 *
 * Codex env shape is forced (no `CLAUDE_ENV_FILE`, no `CLAUDE_PLUGIN_DATA`)
 * so `resolveStateDir` lands deterministically under TMPDIR.
 *
 * macOS Unix socket path limit is 104 chars; bind the socket in a short
 * top-level temp dir (the runtime reads endpoint string from the session
 * JSON, not from any path-arithmetic, so any accessible path works).
 */
async function setupFakeBroker({ withLiveListener = false } = {}) {
  delete process.env[CLAUDE_HOST_SIGNAL_ENV];
  delete process.env[CLAUDE_PLUGIN_DATA_ENV];

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-broker-ensure-"));
  initGitRepo(workspace);

  const { resolveStateDir } = await import(path.join(LIB_DIR, "state.mjs"));
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });

  const sessionDir = path.join(stateDir, ACP_SESSION_DIR_NAME);
  fs.mkdirSync(sessionDir, { recursive: true });

  const shortSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "gem-be-"));
  const socketPath = path.join(shortSocketDir, "b.sock");
  const endpoint = `unix:${socketPath}`;
  const pidFile = path.join(sessionDir, BROKER_PID_FILENAME);
  const logFile = path.join(sessionDir, BROKER_LOG_FILENAME);

  let listener = null;
  if (withLiveListener) {
    listener = await startFakeListener(socketPath);
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: null  // intentionally null — ensureBrokerSession path doesn't kill on dead-endpoint
  };
  const sessionFile = path.join(stateDir, BROKER_SESSION_FILENAME);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf8");

  return {
    workspace,
    stateDir,
    sessionFile,
    endpoint,
    socketPath,
    listener,
    cleanup: async () => {
      if (listener) await stopFakeListener(listener);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(shortSocketDir, { recursive: true, force: true });
    }
  };
}

test("ensureBrokerSession: live endpoint returns existing session (single probe, no respawn)", async () => {
  const { ensureBrokerSession } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));
  const fixture = await setupFakeBroker({ withLiveListener: true });

  // killProcess as a counter — should NOT be called on the live-endpoint path.
  let killCalled = false;
  const result = await ensureBrokerSession(fixture.workspace, {
    killProcess: () => { killCalled = true; }
  });

  assert.ok(result, "ensureBrokerSession must return the existing session info on live endpoint");
  assert.equal(result.endpoint, fixture.endpoint,
    "returned endpoint must match the existing session");
  assert.equal(killCalled, false,
    "killProcess must not be invoked when the existing endpoint is live");
  assert.ok(fs.existsSync(fixture.sessionFile),
    "session file must remain on disk (no teardown on live endpoint)");

  await fixture.cleanup();
});

test("ensureBrokerSession: dead endpoint tears down old session before respawn attempt", async () => {
  const { ensureBrokerSession, teardownBrokerSession } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));
  // No listener — endpoint is dead.
  const fixture = await setupFakeBroker({ withLiveListener: false });

  // Pin a load-bearing precondition: the old session file IS on disk before
  // ensureBrokerSession runs, with a fake-socket endpoint that no live
  // broker would ever emit (the test's setupFakeBroker uses a path under
  // `gem-be-`).
  assert.ok(fs.existsSync(fixture.sessionFile),
    "precondition: stale session file must be on disk before ensureBrokerSession runs");
  const oldEndpoint = fixture.endpoint;
  assert.ok(oldEndpoint && oldEndpoint.includes("gem-be-"),
    `precondition: fixture endpoint must point at the test's short-temp socket; got ${oldEndpoint}`);

  // Run with a generous timeout so behavior does not depend on whether the
  // real `acp-broker.mjs` happens to start in <Xms on the runner. macOS and
  // Ubuntu have very different broker-spawn timings.
  const result = await ensureBrokerSession(fixture.workspace, {
    timeoutMs: 5000,
    killProcess: () => {}
  });

  // Load-bearing invariant: whatever is at `sessionFile` post-call is NOT
  // the old session content. Two valid post-states:
  //   (a) Spawn timed out (slow runner): file is absent — clearBrokerSession
  //       ran, no replacement landed.
  //   (b) Spawn succeeded (fast runner): file exists but holds a NEW session
  //       with a different endpoint pointing at the real broker's socket.
  // Both states prove teardown happened. What FAILS this assertion is the
  // "no teardown" bug — the old fake-socket endpoint still being in the file.
  if (fs.existsSync(fixture.sessionFile)) {
    const onDisk = JSON.parse(fs.readFileSync(fixture.sessionFile, "utf8"));
    assert.notEqual(onDisk.endpoint, oldEndpoint,
      `teardown invariant violated: old session endpoint (${oldEndpoint}) is still on disk after ensureBrokerSession ran (state b would have a different endpoint, state a would have no file)`);
  }
  // else: state (a) — file is absent, teardown unambiguously happened.

  // If spawn succeeded (a fresh broker is now running), tear it down so the
  // test does not leave a zombie process behind.
  if (result) {
    teardownBrokerSession({
      endpoint: result.endpoint,
      pidFile: result.pidFile,
      logFile: result.logFile,
      sessionDir: result.sessionDir,
      pid: result.pid,
      killProcess: (pid) => { try { process.kill(pid); } catch { /* ignore */ } }
    });
  }

  await fixture.cleanup();
});

test("ensureBrokerSession: no prior session — spawn path does not throw on empty state", async () => {
  const { ensureBrokerSession, teardownBrokerSession } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));
  delete process.env[CLAUDE_HOST_SIGNAL_ENV];
  delete process.env[CLAUDE_PLUGIN_DATA_ENV];

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-broker-empty-"));
  initGitRepo(workspace);

  // Sanity: no session file exists.
  const { resolveStateDir } = await import(path.join(LIB_DIR, "state.mjs"));
  const stateDir = resolveStateDir(workspace);
  const sessionFile = path.join(stateDir, BROKER_SESSION_FILENAME);
  assert.ok(!fs.existsSync(sessionFile), "precondition: no session file");

  // Use a generous timeout so the test is timing-insensitive across platforms.
  // Whether spawn succeeds in 100ms (Ubuntu) or 2000ms (macOS) is platform
  // detail; the load-bearing invariant is "no throw on empty state".
  let result;
  await assert.doesNotReject(
    async () => { result = await ensureBrokerSession(workspace, { timeoutMs: 5000 }); },
    "ensureBrokerSession must not throw when invoked with no prior session"
  );

  // Tear down any broker we accidentally spawned so the test is hermetic.
  if (result) {
    teardownBrokerSession({
      endpoint: result.endpoint,
      pidFile: result.pidFile,
      logFile: result.logFile,
      sessionDir: result.sessionDir,
      pid: result.pid,
      killProcess: (pid) => { try { process.kill(pid); } catch { /* ignore */ } }
    });
  }

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("ensureBrokerSession: live endpoint produces exactly ONE probe per call", async () => {
  // After folding staleness check INTO ensureBrokerSession (round-1 swarm fix),
  // there must be exactly one liveness probe per decision. We verify by
  // attaching a counter to the underlying socket connect.
  const { ensureBrokerSession } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));
  const fixture = await setupFakeBroker({ withLiveListener: true });

  let connectCount = 0;
  // Wrap the listener to count incoming connections.
  fixture.listener.on("connection", () => { connectCount += 1; });

  // First call: probe once, return existing.
  await ensureBrokerSession(fixture.workspace, { killProcess: () => {} });

  // Allow event loop tick to register the connection in the listener.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(connectCount, 1,
    `expected exactly 1 liveness probe per call after round-1 swarm fix; got ${connectCount}`);

  await fixture.cleanup();
});
