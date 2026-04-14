/**
 * Process spawning and management utilities.
 */

import { execFileSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import process from "node:process";

/**
 * Run a command synchronously and return the result.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ stdout: string, stderr: string, status: number | null, error: Error | null }}
 */
export function runCommand(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error ?? null
    };
  } catch (/** @type {any} */ error) {
    return {
      stdout: "",
      stderr: error.message ?? "",
      status: 1,
      error
    };
  }
}

/**
 * Run a command synchronously and throw on non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} stdout
 */
export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
}

/**
 * Format a failed command result into a human-readable error message.
 *
 * @param {{ stdout: string, stderr: string, status: number | null }} result
 * @returns {string}
 */
export function formatCommandFailure(result) {
  const parts = [`Command exited with status ${result.status ?? "unknown"}.`];
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }
  return parts.join("\n");
}

/**
 * Check whether a binary is available on PATH.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function binaryAvailable(name) {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(command, [name], { encoding: "utf8", stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Terminate a process and its children.
 *
 * @param {number} pid
 */
export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Try SIGTERM on the process group first.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }

      // Follow up with SIGKILL after a short delay.
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 500);
    }
  } catch {
    // Process may already be gone.
  }
}

/**
 * Spawn a detached child process that outlives the parent.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logFile?: string }} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(command, args, options = {}) {
  const stdio = options.logFile
    ? ["ignore", "ignore", "ignore"]
    : ["ignore", "ignore", "ignore"];

  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio
  });

  child.unref();
  return child;
}
