/**
 * broker-lifecycle.reapStaleBroker — kills orphaned brokers under Codex.
 *
 * Codex has no SessionEnd hook, so prior `gemini --acp` brokers would leak
 * indefinitely. The reaper bounds accumulation by killing brokers that are
 * BOTH old (session-file mtime > STALE_BROKER_AGE_MS) AND not accepting
 * connections.
 *
 * The endpoint check is non-negotiable: a long-running healthy broker (e.g.
 * a Claude Code session running for 2+ hours with idle Gemini) writes its
 * session file once at creation, so mtime alone would kill healthy sessions.
 *
 * Three branches must be tested:
 *   1. fresh mtime → survives regardless of endpoint state (no kill needed)
 *   2. old mtime + live endpoint → SURVIVES (the regression Gemini caught)
 *   3. old mtime + dead endpoint → reaped (the actual orphan case)
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
const REAPER_TMPDIR_PREFIX_WORKSPACE = "gemini-reaper-ws-";
const REAPER_TMPDIR_PREFIX_EMPTY = "gemini-reaper-empty-";
const REAPER_SHORT_SOCKET_PREFIX = "gem-rs-";  // very short; macOS Unix socket path ≤ 104 chars
const FAKE_PID_PLACEHOLDER = 99999;            // never the real broker; only fed to killProcess

function initGitRepo(cwd) {
  spawnSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd, stdio: "ignore" });
}

/**
 * Stand up a temporary Unix socket that accepts and immediately closes
 * connections. The reaper's isBrokerEndpointReady probe just needs a TCP-style
 * connect to succeed — the server doesn't have to speak ACP.
 *
 * macOS limits Unix socket path length to 104 chars. The state-dir tree
 * (TMPDIR/gemini-companion/<slug>-<hash>/acp-session/broker.sock) easily
 * exceeds this on macOS where TMPDIR is /var/folders/h1/.../T/. We bind
 * the socket in a short top-level temp dir and only stash the broker-session
 * pointer in the workspace state-dir tree — the reaper looks up the endpoint
 * from the session JSON, not from path-arithmetic, so the bind path can be
 * anywhere.
 */
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
 * Set up a fake workspace + a `broker-session.json` for the workspace's
 * state dir. The Codex env shape is used (no CLAUDE_ENV_FILE, no
 * CLAUDE_PLUGIN_DATA), which makes the state root deterministic under TMPDIR.
 */
async function setupFakeBroker(opts = {}) {
  const { withLiveListener = false, mtimeOffsetMs = 0 } = opts;

  // Force Codex env shape so resolveStateDir lands under TMPDIR.
  delete process.env[CLAUDE_HOST_SIGNAL_ENV];
  delete process.env[CLAUDE_PLUGIN_DATA_ENV];

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), REAPER_TMPDIR_PREFIX_WORKSPACE));
  initGitRepo(workspace);

  const { resolveStateDir } = await import(path.join(LIB_DIR, "state.mjs"));
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });

  const sessionDir = path.join(stateDir, ACP_SESSION_DIR_NAME);
  fs.mkdirSync(sessionDir, { recursive: true });

  // macOS Unix socket path limit is 104 chars; state-dir paths under
  // /var/folders/.../T/<state-root>/<slug>-<hash>/acp-session/ blow past
  // that. Keep the socket somewhere short — the reaper reads the endpoint
  // string from broker-session.json, not from any path-arithmetic, so any
  // accessible path works.
  const shortSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), REAPER_SHORT_SOCKET_PREFIX));
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
    pid: FAKE_PID_PLACEHOLDER  // intentionally fake; only fed to killProcess
  };
  const sessionFile = path.join(stateDir, BROKER_SESSION_FILENAME);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf8");

  // Adjust the session file's mtime to simulate an old/fresh broker.
  if (mtimeOffsetMs !== 0) {
    const targetMs = Date.now() - mtimeOffsetMs;
    fs.utimesSync(sessionFile, targetMs / 1000, targetMs / 1000);
  }

  return {
    workspace,
    sessionFile,
    socketPath,
    endpoint,
    listener,
    cleanup: async () => {
      if (listener) await stopFakeListener(listener);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(shortSocketDir, { recursive: true, force: true });
    }
  };
}

test("reaper: fresh session-file mtime → broker survives even if endpoint is dead", async () => {
  const { reapStaleBroker } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));
  const fixture = await setupFakeBroker({ withLiveListener: false, mtimeOffsetMs: 0 });

  let killCalled = false;
  await reapStaleBroker(fixture.workspace, () => { killCalled = true; });

  // Session file must still be on disk; reaper bailed early due to fresh mtime.
  assert.ok(fs.existsSync(fixture.sessionFile),
    "fresh broker must NOT be reaped (mtime check is the first gate)");
  assert.equal(killCalled, false, "killProcess must not be invoked on a fresh broker");

  await fixture.cleanup();
});

test("reaper: old session-file mtime + LIVE endpoint → broker survives (the round-2 regression)", async () => {
  const { reapStaleBroker, STALE_BROKER_AGE_MS } = await import(
    path.join(LIB_DIR, "broker-lifecycle.mjs")
  );
  const fixture = await setupFakeBroker({
    withLiveListener: true,
    mtimeOffsetMs: STALE_BROKER_AGE_MS + 60_000  // 1h + 1min old
  });

  let killCalled = false;
  await reapStaleBroker(fixture.workspace, () => { killCalled = true; });

  assert.ok(fs.existsSync(fixture.sessionFile),
    "broker with old mtime BUT live endpoint must NOT be reaped — it's healthy");
  assert.equal(killCalled, false,
    "killProcess must not fire when endpoint accepts connections, regardless of mtime");

  await fixture.cleanup();
});

test("reaper: old session-file mtime + DEAD endpoint → broker is reaped", async () => {
  const { reapStaleBroker, STALE_BROKER_AGE_MS } = await import(
    path.join(LIB_DIR, "broker-lifecycle.mjs")
  );
  const fixture = await setupFakeBroker({
    withLiveListener: false,
    mtimeOffsetMs: STALE_BROKER_AGE_MS + 60_000
  });

  let killCalled = false;
  await reapStaleBroker(fixture.workspace, () => { killCalled = true; });

  assert.ok(!fs.existsSync(fixture.sessionFile),
    "stale broker (old + dead) must be reaped — its session file is removed");
  assert.equal(killCalled, true,
    "killProcess must fire on a confirmed-orphan broker");

  await fixture.cleanup();
});

test("reaper: no session file → no-op (nothing to reap)", async () => {
  const { reapStaleBroker } = await import(path.join(LIB_DIR, "broker-lifecycle.mjs"));

  // Force Codex env shape and use a fresh workspace with NO session file.
  delete process.env[CLAUDE_HOST_SIGNAL_ENV];
  delete process.env[CLAUDE_PLUGIN_DATA_ENV];

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), REAPER_TMPDIR_PREFIX_EMPTY));
  initGitRepo(workspace);

  let killCalled = false;
  // Must not throw, must not call killProcess.
  await reapStaleBroker(workspace, () => { killCalled = true; });

  assert.equal(killCalled, false, "no session file means no broker to reap");

  fs.rmSync(workspace, { recursive: true, force: true });
});
