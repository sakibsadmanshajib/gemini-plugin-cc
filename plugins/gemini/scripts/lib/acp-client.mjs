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

import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { attachStderrDiagnosticCollector, BROKER_DIAGNOSTIC_METHOD, sanitizeDiagnosticMessage } from "./acp-diagnostics.mjs";
import { getPluginInfo } from "./plugin-info.mjs";

export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Maximum retained size (in characters) of the in-progress line buffer. Guards
// against memory growth from a peer that never emits a newline. Full ACP
// messages are line-delimited and normally well under 1 MiB.
export const ACP_MAX_LINE_BUFFER = 1 << 20;

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
    this.onDiagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : null;

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
    if (message.method === BROKER_DIAGNOSTIC_METHOD) {
      // Trust boundary: only the broker transport may emit
      // broker/diagnostic as a trusted diagnostic. In direct mode the peer is
      // the `gemini --acp` child — a forged notification on its stdout MUST
      // NOT be promoted to a broker diagnostic.
      if (this.transport === "broker") {
        if (this.onDiagnostic) {
          try {
            this.onDiagnostic({
              source: message.params?.source ?? "broker",
              message: message.params?.message ?? ""
            });
          } catch {
            // Best-effort telemetry.
          }
        }
        // Single-dispatch: do NOT also forward to onNotification, otherwise
        // callers that register both handlers would record the diagnostic
        // twice.
        return;
      }
      // Direct mode: fall through to the regular onNotification path so the
      // caller can decide how to handle (or ignore) the untrusted payload.
    }

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
    // Guard against an unbounded line-less flood from a misbehaving peer.
    if (this.lineBuffer.length > ACP_MAX_LINE_BUFFER) {
      const dropped = this.lineBuffer.length - ACP_MAX_LINE_BUFFER;
      this.lineBuffer = this.lineBuffer.slice(-ACP_MAX_LINE_BUFFER);
      if (this.onDiagnostic) {
        try {
          this.onDiagnostic({
            source: "acp-transport",
            message: sanitizeDiagnosticMessage(
              `[line buffer overflow — dropped ${dropped} bytes]`
            )
          });
        } catch {
          // Best-effort telemetry — never let diagnostic delivery crash the ACP client.
        }
      }
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
    const info = getPluginInfo();
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: info.name, version: info.version }
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

    // Capture bounded stderr lines as diagnostics; always drain to prevent back-pressure.
    if (this.proc.stderr) {
      attachStderrDiagnosticCollector(this.proc.stderr, (message) => {
        if (this.onDiagnostic) {
          try {
            this.onDiagnostic({ source: "direct-stderr", message });
          } catch {
            // Best-effort.
          }
        }
      });
    }

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

// ─── Test-only helpers ───────────────────────────────────────────────────────
//
// Exposes pieces of AcpClientBase to unit tests without having to spawn a real
// child process or bind a broker socket. Not part of the public API — anything
// prefixed with `__` is test-only.

export const __testing = {
  /**
   * Invoke AcpClientBase.handleLine against a fake client object.
   *
   * @param {{ transport: string, pending: Map<number, any>, nextId: number,
   *           lineBuffer: string, onNotification?: Function,
   *           onDiagnostic?: Function }} client
   * @param {string} line
   */
  handleLineOn(client, line) {
    return AcpClientBase.prototype.handleLine.call(client, line);
  },

  /**
   * Invoke AcpClientBase.handleChunk against a fake client object. Used to
   * exercise the line-buffer overflow diagnostic without spawning a real
   * subprocess or broker socket.
   *
   * @param {{ transport: string, pending: Map<number, any>, nextId: number,
   *           lineBuffer: string, onNotification?: Function,
   *           onDiagnostic?: Function }} client
   * @param {string} chunk
   */
  handleChunkOn(client, chunk) {
    return AcpClientBase.prototype.handleChunk.call(client, chunk);
  }
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export class GeminiAcpClient {
  /**
   * Connect to a Gemini ACP instance. Tries broker first, falls back to direct.
   *
   * @param {string} cwd
   * @param {{ disableBroker?: boolean, brokerEndpoint?: string | null, reuseExistingBroker?: boolean, env?: NodeJS.ProcessEnv, onNotification?: NotificationHandler, onDiagnostic?: (payload: { source: string, message: string }) => void }} [options]
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
        const fallbackMessage = error?.code === BROKER_BUSY_RPC_CODE
          ? "Broker busy, falling back to direct gemini --acp spawn."
          : `Broker connection failed (${error?.message ?? error}), falling back to direct spawn.`;
        process.stderr.write(`${fallbackMessage}\n`);
        if (typeof options.onDiagnostic === "function") {
          try {
            options.onDiagnostic({
              source: "broker-fallback",
              message: sanitizeDiagnosticMessage(fallbackMessage)
            });
          } catch {
            // Best-effort.
          }
        }
      }
    }

    // Direct spawn fallback.
    const client = new SpawnedAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
