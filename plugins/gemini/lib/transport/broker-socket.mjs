/**
 * BrokerSocketTransport — `ClientTransport` connecting to an existing broker
 * over a Unix domain socket (Linux/macOS) or named pipe (Windows).
 *
 * Where `CliTransport` spawns a fresh CLI subprocess per session,
 * BrokerSocketTransport connects to a long-running broker that already has
 * a CLI subprocess attached. Multiple clients can share one broker, which
 * is essential for cross-cutting operations like `session/cancel` against
 * a session owned by a different client.
 *
 * The broker process itself is `plugins/gemini/scripts/acp-broker.mjs` —
 * unchanged by this transport. The broker's socket handshake is the same
 * line-framed JSON-RPC the broker speaks to its CLI child, so this transport
 * is just a different way to reach the same protocol.
 */

import { EventEmitter } from "node:events";
import net from "node:net";

import { createLineBuffer, frame } from "../acp/framing.mjs";
import { openWireLog } from "../wire-log.mjs";

const CONNECT_TIMEOUT_MS = 2000;

/**
 * @typedef {import("../acp/types.mjs").HealthState} HealthState
 * @typedef {import("../acp/types.mjs").JsonRpcMessage} JsonRpcMessage
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 */

/**
 * @param {{
 *   endpoint: string,
 *   connectTimeoutMs?: number,
 *   wireLog?: ReturnType<typeof openWireLog>
 * }} options
 * @returns {ClientTransport}
 */
export function createBrokerSocketTransport(options) {
  const { endpoint } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const wireLog = options.wireLog ?? openWireLog();

  const events = new EventEmitter();
  const buffer = createLineBuffer();

  /** @type {net.Socket | null} */
  let socket = null;
  /** @type {HealthState} */
  let health = "queued";
  let starting = false;
  let started = false;
  let closing = false;

  function setHealth(next) {
    if (health === next) return;
    health = next;
    events.emit("health", next);
  }

  function emitMessage(line) {
    /** @type {JsonRpcMessage | null} */
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed) return;
    wireLog.record("in", parsed);
    events.emit("message", parsed);
  }

  return {
    async start() {
      if (started || starting) return;
      starting = true;
      await new Promise((resolve, reject) => {
        const sock = net.createConnection(endpoint);
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error(`BrokerSocket connect timeout (${endpoint})`));
        }, connectTimeoutMs);
        timer.unref?.();

        sock.once("connect", () => {
          clearTimeout(timer);
          socket = sock;
          started = true;
          starting = false;
          setHealth("active");

          sock.setEncoding("utf8");
          sock.on("data", (chunk) => {
            // setEncoding("utf8") above guarantees string chunks at runtime,
            // but TypeScript's net.Socket type doesn't narrow.
            const text = /** @type {string} */ (/** @type {unknown} */ (chunk));
            for (const line of buffer.feed(text)) emitMessage(line);
          });
          sock.on("close", () => {
            if (closing) {
              setHealth("completed");
            } else {
              setHealth("worker_missing");
            }
            started = false;
          });
          sock.on("error", (err) => {
            process.stderr.write(`[broker-socket] error: ${err.message}\n`);
            setHealth("worker_missing");
          });

          resolve();
        });

        sock.once("error", (err) => {
          clearTimeout(timer);
          starting = false;
          reject(err);
        });
      });
    },

    send(message) {
      if (!socket || socket.destroyed) {
        throw new Error(`BrokerSocketTransport: socket unavailable (${endpoint})`);
      }
      wireLog.record("out", message);
      socket.write(frame(message));
    },

    onMessage(handler) {
      events.on("message", handler);
    },

    onHealthChange(handler) {
      events.on("health", handler);
    },

    healthState() {
      return health;
    },

    async close() {
      if (!started || closing) return;
      closing = true;
      const sock = socket;
      if (!sock || sock.destroyed) return;

      await new Promise((resolve) => {
        sock.once("close", resolve);
        sock.end();
        // Belt and suspenders — net.Socket.end() should close, but if peer
        // is unresponsive, force after grace.
        const timer = setTimeout(() => {
          if (!sock.destroyed) sock.destroy();
          resolve();
        }, 500);
        timer.unref?.();
      });
    },

    isOpen() {
      return started && !closing && socket !== null && !socket.destroyed;
    }
  };
}
