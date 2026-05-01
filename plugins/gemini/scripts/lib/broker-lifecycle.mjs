/**
 * Broker process lifecycle management — spawning, health-checking, and tearing
 * down the persistent ACP broker process.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "GEMINI_COMPANION_ACP_PID_FILE";
export const LOG_FILE_ENV = "GEMINI_COMPANION_ACP_LOG_FILE";

const BROKER_SCRIPT = path.resolve(
  fileURLToPath(new URL("../acp-broker.mjs", import.meta.url))
);

const SESSION_DIR_NAME = "acp-session";
// Brokers older than this AND not accepting connections are reaped.
// Codex has no SessionEnd hook, so prior Codex-invoked brokers would otherwise
// leak. The reaper checks BOTH conditions — never kills a healthy broker even
// if its session-file mtime is old (legitimate idle case under Claude Code).
export const STALE_BROKER_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Wait for a broker endpoint to accept connections.
 *
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForBrokerEndpoint(endpoint, timeoutMs) {
  return new Promise((resolve) => {
    const target = parseBrokerEndpoint(endpoint);
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ path: target.path });
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

function resolveSessionDir(cwd) {
  return path.join(resolveStateDir(cwd), SESSION_DIR_NAME);
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "broker-session.json");
}

/**
 * Load the persisted broker session info, if available.
 *
 * @param {string} cwd
 * @returns {{ endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null } | null}
 */
export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function saveBrokerSession(cwd, session) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), JSON.stringify(session, null, 2), "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

/**
 * @deprecated Not called from runtime as of round-1 swarm fix.
 *   `ensureBrokerSession` now folds in the liveness check itself (single
 *   probe per decision) and never calls this function. Retained as a
 *   public API surface only to keep `broker-reaper.test.mjs` green; new
 *   callers should rely on `ensureBrokerSession`'s built-in teardown
 *   path instead. Slated for removal in a follow-up cleanup PR once the
 *   reaper tests are migrated to exercise `ensureBrokerSession` directly.
 *
 * Kill any orphaned broker for this workspace. Codex has no SessionEnd hook,
 * so prior brokers can leak. We treat a broker as stale ONLY if BOTH:
 *   1. its session file is older than STALE_BROKER_AGE_MS, AND
 *   2. its endpoint is not accepting connections.
 *
 * The endpoint check is non-negotiable: a long-running broker that is
 * legitimately idle (e.g. Claude Code session running for 2+ hours with no
 * Gemini calls) writes its session file exactly once at creation, so mtime
 * alone would falsely flag it as stale and murder a healthy session.
 *
 * @param {string} cwd
 * @param {((pid: number) => void) | null} killProcess
 * @returns {Promise<void>}
 */
export async function reapStaleBroker(cwd, killProcess) {
  let stat;
  try {
    stat = fs.statSync(resolveBrokerStateFile(cwd));
  } catch {
    return;
  }
  if (Date.now() - stat.mtimeMs < STALE_BROKER_AGE_MS) {
    return;
  }
  const session = loadBrokerSession(cwd);
  if (!session) {
    return;
  }
  // Endpoint liveness is the actual safety check. If the broker is still
  // accepting connections, it's healthy regardless of session-file age —
  // do not kill it.
  if (await isBrokerEndpointReady(session.endpoint)) {
    return;
  }
  if (typeof session.pid === "number" && killProcess) {
    try {
      killProcess(session.pid);
    } catch {
      // ignore
    }
  }
  teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    killProcess: null  // already killed above
  });
  clearBrokerSession(cwd);
}

/**
 * Ensure a broker process is running for the given workspace. Starts one if needed.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, killProcess?: (pid: number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<{ endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null } | null>}
 */
export async function ensureBrokerSession(cwd, options = {}) {
  // Single liveness probe per decision. Under Codex there's no SessionEnd
  // hook, so prior brokers can leak — the staleness check is folded in here
  // (no separate reaper call) so the endpoint is probed exactly ONCE per
  // ensureBrokerSession invocation, regardless of session-file age.
  //
  // Decision tree:
  //   1. No session file        → spawn new broker.
  //   2. Endpoint accepts conns → return existing (healthy, regardless of mtime).
  //   3. Endpoint dead          → tear down old session, spawn new broker.
  //
  // Rationale (from round-1 swarm review): a status-enum from a separate
  // reapStaleBroker() call would create a freshness race — the broker can die
  // between the reaper's probe and ensureBrokerSession's decision to skip its
  // own probe. One probe per decision is race-free by construction.
  const existing = loadBrokerSession(cwd);
  if (!existing) {
    // No prior session — fall through to spawn path below.
  } else if (await isBrokerEndpointReady(existing.endpoint)) {
    // Healthy broker, regardless of mtime. Reuse.
    return existing;
  } else {
    // Existing session file but endpoint not responding. Old broker is dead;
    // tear down before spawning a fresh one.
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = resolveSessionDir(cwd);
  fs.mkdirSync(sessionDir, { recursive: true });

  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  const child = spawn("node", [
    BROKER_SCRIPT,
    "serve",
    "--endpoint", endpoint,
    "--cwd", cwd,
    "--pid-file", pidFile
  ], {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...options.env ?? process.env,
      [PID_FILE_ENV]: pidFile,
      [LOG_FILE_ENV]: logFile
    }
  });

  child.unref();

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

/**
 * Tear down a broker session, killing the process and cleaning up files.
 *
 * @param {{ endpoint?: string | null, pidFile?: string | null, logFile?: string | null, sessionDir?: string | null, pid?: number | null, killProcess?: ((pid: number) => void) | null }} params
 */
export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore cleanup failures.
    }
  }

  if (sessionDir) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

/**
 * Send a broker/shutdown message to a running broker.
 *
 * @param {string} endpoint
 * @returns {Promise<boolean>}
 */
export async function sendBrokerShutdown(endpoint) {
  if (!endpoint) {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const target = parseBrokerEndpoint(endpoint);
      const socket = net.createConnection({ path: target.path });
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broker/shutdown",
        params: {}
      });

      socket.on("connect", () => {
        socket.write(`${message}\n`);
        // Give the broker time to process before closing.
        setTimeout(() => {
          socket.end();
          resolve(true);
        }, 200);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });

      // Timeout the entire operation.
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    } catch {
      resolve(false);
    }
  });
}
