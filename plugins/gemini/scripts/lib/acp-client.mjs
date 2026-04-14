/**
 * ACP (Agent Client Protocol) JSON-RPC client for communicating with `gemini --acp`.
 *
 * Three classes:
 * - AcpClientBase: Shared JSON-RPC logic (request/response matching, notifications, line parsing)
 * - SpawnedAcpClient: Spawns `gemini --acp` as a child process (direct mode)
 * - BrokerAcpClient: Connects to broker via Unix socket
 *
 * Factory:
 * - GeminiAcpClient.connect(): Tries broker first, falls back to direct spawn
 */

import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

/**
 * @typedef {import("./acp-protocol").JsonRpcRequest} JsonRpcRequest
 * @typedef {import("./acp-protocol").JsonRpcResponse} JsonRpcResponse
 * @typedef {import("./acp-protocol").JsonRpcNotification} JsonRpcNotification
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").InitializeResult} InitializeResult
 */

/**
 * @callback NotificationHandler
 * @param {JsonRpcNotification} notification
 * @returns {void}
 */

// ─── Base Client ──────────────────────────────────────────────────────────────

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.transport = "unknown";
    this.nextId = 1;

    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
    this.pending = new Map();

    /** @type {NotificationHandler | null} */
    this.onNotification = options.onNotification ?? null;

    this.lineBuffer = "";
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.exitResolved = false;
    this.exitError = null;
    this.closed = false;

    /** @type {InitializeResult | null} */
    this.capabilities = null;
  }

  handleLine(line) {
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

    // Response (has id).
    if ("id" in message && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Notification (no id).
    if (message.method && this.onNotification) {
      this.onNotification(message);
    }
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  async request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params: params ?? {} };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  notify(method, params) {
    this.sendMessage({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /**
   * Initialize the ACP connection with a handshake.
   *
   * @returns {Promise<InitializeResult>}
   */
  async handshake() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: PLUGIN_MANIFEST.name ?? "gemini-plugin-cc",
        version: PLUGIN_MANIFEST.version ?? "1.0.0"
      }
    });
    this.capabilities = result;
    return result;
  }

  async close() {
    throw new Error("close must be implemented by subclasses.");
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

// ─── Direct (Spawned) Client ──────────────────────────────────────────────────

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("gemini", ["--acp"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.on("exit", (code) => {
      this.handleExit(code !== 0 ? new Error(`gemini --acp exited with code ${code}`) : null);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    // Drain stderr to prevent back-pressure.
    this.proc.stderr?.resume();

    await this.handshake();
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const pid = this.proc?.pid;
    if (this.proc?.stdin) {
      this.proc.stdin.end();
    }

    // Give a grace period, then force kill.
    if (pid) {
      setTimeout(() => {
        try {
          terminateProcessTree(pid);
        } catch {
          // Already exited.
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("gemini --acp stdin is not available.");
    }
    stdin.write(line);
  }
}

// ─── Broker Client ────────────────────────────────────────────────────────────

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(null);
      });
    });

    await this.handshake();
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("ACP broker connection is not connected.");
    }
    socket.write(line);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export class GeminiAcpClient {
  /**
   * Connect to a Gemini ACP instance. Tries broker first, falls back to direct.
   *
   * @param {string} cwd
   * @param {{ disableBroker?: boolean, brokerEndpoint?: string | null, reuseExistingBroker?: boolean, env?: NodeJS.ProcessEnv, onNotification?: NotificationHandler }} [options]
   * @returns {Promise<AcpClientBase>}
   */
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }

    if (brokerEndpoint) {
      try {
        const client = new BrokerAcpClient(cwd, { ...options, brokerEndpoint });
        await client.initialize();
        return client;
      } catch (error) {
        // If broker is busy, fall through to direct spawn.
        if (error?.code === BROKER_BUSY_RPC_CODE) {
          process.stderr.write("Broker busy, falling back to direct gemini --acp spawn.\n");
        } else {
          process.stderr.write(`Broker connection failed (${error?.message ?? error}), falling back to direct spawn.\n`);
        }
      }
    }

    // Direct spawn fallback.
    const client = new SpawnedAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
