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
 * Ensure a broker process is running for the given workspace. Starts one if needed.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, killProcess?: (pid: number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<{ endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null } | null>}
 */
export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
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
