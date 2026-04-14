/**
 * Broker endpoint resolution — Unix sockets on Linux/macOS, named pipes on Windows.
 */

import path from "node:path";
import process from "node:process";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Create a broker endpoint string for the given session directory.
 *
 * @param {string} sessionDir
 * @param {string} [platform]
 * @returns {string}
 */
export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-gemini-acp`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  return `unix:${path.join(sessionDir, "broker.sock")}`;
}

/**
 * Parse a broker endpoint string into its kind and path.
 *
 * @param {string} endpoint
 * @returns {{ kind: "unix" | "pipe", path: string }}
 */
export function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }

  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
