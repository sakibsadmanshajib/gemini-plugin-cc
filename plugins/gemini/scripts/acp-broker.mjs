#!/usr/bin/env node

/**
 * Persistent ACP broker daemon. Listens on a Unix socket (Linux/macOS) or named
 * pipe (Windows), spawns a single `gemini --acp` child process, and multiplexes
 * JSON-RPC requests from multiple client connections.
 *
 * Usage:
 *   node scripts/acp-broker.mjs serve --endpoint <unix:/path|pipe:\\\\.\\pipe\\name> [--cwd <path>] [--pid-file <path>]
 *
 * Returns BROKER_BUSY_RPC_CODE (-32001) when another request is in flight.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { listenOnRestrictedUnixSocket } from "./lib/socket-permissions.mjs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const SHUTDOWN_GRACE_MS = 500;

// ─── Gemini ACP Child Process ─────────────────────────────────────────────────

let acpProcess = null;
let acpReady = false;
let nextRpcId = 1;

/** @type {Map<number, { clientSocket: net.Socket, clientId: number }>} */
const pendingRequests = new Map();

/** @type {net.Socket | null} */
let activeClient = null;

function spawnAcpProcess(cwd) {
  const child = spawn("gemini", ["--acp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => handleAcpLine(line));

  child.stderr?.resume(); // Drain stderr.

  child.on("exit", (code) => {
    process.stderr.write(`gemini --acp exited with code ${code}\n`);
    acpProcess = null;
    acpReady = false;

    // Reject all pending requests.
    for (const [id, pending] of pendingRequests) {
      send(pending.clientSocket, {
        jsonrpc: "2.0",
        id: pending.clientId,
        error: buildJsonRpcError(-32000, "ACP process exited unexpectedly.")
      });
    }
    pendingRequests.clear();
  });

  child.on("error", (error) => {
    process.stderr.write(`gemini --acp error: ${error.message}\n`);
    acpProcess = null;
    acpReady = false;
  });

  acpProcess = child;

  // Send initialize handshake.
  const initId = nextRpcId++;
  sendToAcp({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      clientInfo: {
        name: "gemini-plugin-cc-broker",
        version: "1.0.0"
      }
    }
  });

  // The first response will be the initialize result.
  pendingRequests.set(initId, { clientSocket: null, clientId: null });

  return child;
}

function sendToAcp(message) {
  if (!acpProcess?.stdin) {
    return;
  }
  acpProcess.stdin.write(`${JSON.stringify(message)}\n`);
}

function handleAcpLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle response (has id).
  if ("id" in message && message.id !== null) {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pendingRequests.delete(message.id);

      if (pending.clientSocket === null) {
        // Initialize response — mark as ready.
        acpReady = true;
        process.stderr.write("ACP broker: gemini --acp initialized.\n");
        return;
      }

      // Forward response to the client with their original id.
      send(pending.clientSocket, {
        jsonrpc: "2.0",
        id: pending.clientId,
        result: message.result,
        error: message.error
      });

      // If no more pending requests for this client, release the lock.
      const hasMore = [...pendingRequests.values()].some(
        (p) => p.clientSocket === pending.clientSocket
      );
      if (!hasMore) {
        activeClient = null;
      }
    }
    return;
  }

  // Handle notification — forward to active client if any.
  if (message.method && activeClient && !activeClient.destroyed) {
    send(activeClient, message);
  }
}

// ─── Client Connection Handling ───────────────────────────────────────────────

function handleClientConnection(socket) {
  let lineBuffer = "";

  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    lineBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      handleClientMessage(socket, line);
    }
  });

  socket.on("error", () => {
    // Clean up any pending requests for this socket.
    for (const [id, pending] of pendingRequests) {
      if (pending.clientSocket === socket) {
        pendingRequests.delete(id);
      }
    }
    if (activeClient === socket) {
      activeClient = null;
    }
  });

  socket.on("close", () => {
    if (activeClient === socket) {
      activeClient = null;
    }
  });
}

function handleClientMessage(socket, line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle broker/shutdown.
  if (message.method === "broker/shutdown") {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: { ok: true }
    });
    shutdown();
    return;
  }

  // Handle initialize — respond directly (broker handles handshake).
  if (message.method === "initialize") {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        capabilities: {},
        serverInfo: {
          name: "gemini-plugin-cc-broker",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  // Check if broker is busy.
  if (activeClient && activeClient !== socket) {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Broker is busy with another request.")
    });
    return;
  }

  // Check if ACP process is ready.
  if (!acpProcess || !acpReady) {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: buildJsonRpcError(-32000, "ACP process is not ready.")
    });
    return;
  }

  // Forward request to ACP process.
  activeClient = socket;
  const brokerId = nextRpcId++;
  pendingRequests.set(brokerId, { clientSocket: socket, clientId: message.id });

  sendToAcp({
    jsonrpc: "2.0",
    id: brokerId,
    method: message.method,
    params: message.params ?? {}
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

let server = null;

function shutdown() {
  process.stderr.write("ACP broker shutting down.\n");

  // Kill the ACP process.
  if (acpProcess) {
    try {
      acpProcess.kill("SIGTERM");
    } catch {
      // Ignore.
    }
  }

  // Close the server.
  if (server) {
    server.close();
  }

  setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const target = parseBrokerEndpoint(options.endpoint);

  // Clean up stale socket file.
  if (target.kind === "unix" && fs.existsSync(target.path)) {
    fs.unlinkSync(target.path);
  }

  writePidFile(pidFile);

  // Spawn the Gemini ACP process.
  spawnAcpProcess(cwd);

  // Start listening.
  server = net.createServer(handleClientConnection);

  if (target.kind === "unix") {
    fs.mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o700 });
    listenOnRestrictedUnixSocket(server, target.path, () => {
      process.stderr.write(`ACP broker listening on ${target.path}\n`);
    });
  } else {
    server.listen(target.path, () => {
      process.stderr.write(`ACP broker listening on ${target.path}\n`);
    });
  }

  // Handle signals.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
