/**
 * Unit tests for the broker probe in `lib/transport/broker-probe.mjs`.
 *
 * The probe is the gating function for the Phase 0 broker-aware
 * dispatch path. Its correctness is the difference between a healthy
 * warm-route and an attacker-controlled-socket-RCE; we assert each
 * gate explicitly with isolated state-dir trees.
 *
 * Test fixture pattern: per-test temp dir that mimics the broker's
 * state-tree layout (`<root>/<slug>-<hash>/broker-session.json` plus a
 * unix-socket file). The probe takes `cwd` and `env`; we wire env vars
 * to point at the temp dir for deterministic resolution.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  findActiveBroker,
  loadBrokerSession,
  resolveBrokerSessionFile,
  resolveBrokerStateDir
} from "#lib/transport/broker-probe.mjs";

/** @type {string} */
let tmpRoot;
/** @type {string} */
let cwd;
/** @type {string} */
let stateDir;
/** @type {string} */
let sessionFile;
/** @type {string} */
let socketPath;
/** @type {net.Server | null} */
let socketServer = null;

beforeEach(() => {
  // AF_UNIX paths max out at 104 chars on macOS / 108 on Linux. The
  // default TMPDIR on macOS is `/var/folders/...` which is already
  // ~50 chars; once we add `gemini-companion/<slug>-<hash>/broker.sock`
  // we routinely exceed the limit. Use `/tmp` (short, symlink to
  // /private/tmp on macOS but the bind path itself is the literal
  // string we pass — short and stable).
  tmpRoot = fs.mkdtempSync(path.join("/tmp", "bkp-"));
  // Use the tmpRoot as the cwd so the probe's state-dir resolution
  // computes a deterministic slug+hash under the test's TMPDIR override.
  cwd = fs.mkdtempSync(path.join(tmpRoot, "ws-"));
  // Force the probe to use FALLBACK_STATE_ROOT_DIR by NOT setting
  // CLAUDE_ENV_FILE/CLAUDE_PLUGIN_DATA. The probe uses os.tmpdir() —
  // which we override via TMPDIR for this test.
  process.env.TMPDIR = tmpRoot;
  // resolveBrokerStateDir will compute path.join(os.tmpdir(),
  // "gemini-companion", `<slug>-<hash>`).
  stateDir = resolveBrokerStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  sessionFile = resolveBrokerSessionFile(cwd);
  socketPath = path.join(stateDir, "broker.sock");
});

afterEach(() => {
  if (socketServer) {
    try {
      socketServer.close();
    } catch {
      // best-effort
    }
    socketServer = null;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "TMPDIR");
});

/**
 * Spawn a unix-socket server at `socketPath` so the probe's
 * `isSocketOwned` check can stat it. Returns a promise resolved when
 * the server is listening.
 */
function listenSocket() {
  return new Promise((resolve, reject) => {
    socketServer = net.createServer();
    socketServer.on("error", reject);
    socketServer.listen(socketPath, () => resolve(undefined));
  });
}

function writeSession(overrides = {}) {
  const session = {
    endpoint: `unix:${socketPath}`,
    pid: process.pid,
    pidFile: null,
    logFile: null,
    sessionDir: stateDir,
    ...overrides
  };
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  return session;
}

test("loadBrokerSession: returns null when file missing", () => {
  expect(loadBrokerSession(cwd)).toBeNull();
});

test("loadBrokerSession: returns null on malformed JSON", () => {
  fs.writeFileSync(sessionFile, "not json {{{");
  expect(loadBrokerSession(cwd)).toBeNull();
});

test("loadBrokerSession: returns null when endpoint is missing", () => {
  fs.writeFileSync(sessionFile, JSON.stringify({ pid: 1 }));
  expect(loadBrokerSession(cwd)).toBeNull();
});

test("loadBrokerSession: returns parsed object when valid", () => {
  const session = writeSession();
  expect(loadBrokerSession(cwd)).toEqual(session);
});

test("findActiveBroker: returns null when no session file", async () => {
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns null when pid is dead", async () => {
  await listenSocket();
  // Pick a pid we know is dead. PID 0 is not a real process; on POSIX
  // process.kill(0, 0) returns true (refers to current process group).
  // Use a high number unlikely to be allocated.
  writeSession({ pid: 999999 });
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns null when pid field is missing", async () => {
  await listenSocket();
  fs.writeFileSync(sessionFile, JSON.stringify({ endpoint: `unix:${socketPath}` }));
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns null when socket file is missing", () => {
  // Don't create the socket. Session file points at a nonexistent path.
  writeSession();
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns endpoint when all checks pass", async () => {
  await listenSocket();
  const session = writeSession();
  expect(findActiveBroker(cwd)).toBe(session.endpoint);
});

test("findActiveBroker: returns null when endpoint is empty string", async () => {
  await listenSocket();
  writeSession({ endpoint: "" });
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns null on unsupported endpoint scheme", async () => {
  await listenSocket();
  writeSession({ endpoint: "tcp://127.0.0.1:8080" });
  expect(findActiveBroker(cwd)).toBeNull();
});

test("findActiveBroker: returns null when session file is unreadable", () => {
  // Write a directory at the session file path to force a read error.
  fs.mkdirSync(sessionFile);
  expect(findActiveBroker(cwd)).toBeNull();
});

test("resolveBrokerStateDir: deterministic — same cwd → same path", () => {
  expect(resolveBrokerStateDir(cwd)).toBe(resolveBrokerStateDir(cwd));
});

test("resolveBrokerStateDir: different cwds yield different paths", () => {
  const cwd2 = fs.mkdtempSync(path.join(tmpRoot, "workspace2-"));
  expect(resolveBrokerStateDir(cwd)).not.toBe(resolveBrokerStateDir(cwd2));
});

test("resolveBrokerStateDir: hash component is 12 chars (collision-resistant)", () => {
  const dir = resolveBrokerStateDir(cwd);
  const basename = path.basename(dir);
  // Format is `<slug>-<12-char-hex-hash>`
  const hashMatch = /-([0-9a-f]{12})$/.exec(basename);
  expect(hashMatch).not.toBeNull();
  expect(hashMatch?.[1]).toBe(createHash("sha256").update(cwd).digest("hex").slice(0, 12));
});
