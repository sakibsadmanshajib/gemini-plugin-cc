/**
 * Generic ACP client built on any AcpSession-conformant transport.
 *
 * Wraps a transport with request/response correlation, notification
 * dispatch, and a health-label observer. The client is transport-agnostic
 * — give it CliTransport, the in-memory paired transport, or a future
 * SDK transport, and it behaves the same.
 *
 * This is the layer the v2 multi-backend runtime will sit on top of. The
 * legacy `acp-client.mjs` at `plugins/gemini/scripts/lib/` predates this
 * abstraction and continues to drive the gemini-plugin-baseline runtime
 * unchanged; this file is the parallel layer until the runtime is migrated.
 */

import { EventEmitter } from "node:events";

/**
 * @typedef {import("./types.mjs").AcpSession} AcpSession
 * @typedef {import("./types.mjs").HealthState} HealthState
 * @typedef {import("./types.mjs").JsonRpcMessage} JsonRpcMessage
 * @typedef {import("./types.mjs").JsonRpcNotification} JsonRpcNotification
 * @typedef {import("./types.mjs").JsonRpcRequest} JsonRpcRequest
 * @typedef {import("./types.mjs").JsonRpcResponse} JsonRpcResponse
 */

/**
 * Internal transport surface — the minimum a transport must expose for the
 * client to drive it. AcpSession is the public contract; this is the
 * raw I/O hook the client uses internally.
 *
 * @typedef {object} ClientTransport
 * @property {() => Promise<void>} start
 * @property {(message: JsonRpcMessage) => void} send
 * @property {(handler: (message: JsonRpcMessage) => void) => void} onMessage
 * @property {(handler: (state: HealthState) => void) => void} onHealthChange
 * @property {() => HealthState} healthState
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 */

/**
 * Build a generic ACP client over a transport.
 *
 * @param {ClientTransport} transport
 * @returns {AcpSession}
 */
export function createAcpClient(transport) {
  const events = new EventEmitter();
  /** @type {Map<number | string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;

  transport.onMessage((message) => {
    if (
      message &&
      typeof message === "object" &&
      "id" in message &&
      message.id !== null &&
      message.id !== undefined &&
      ("result" in message || "error" in message)
    ) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      const response = /** @type {JsonRpcResponse} */ (message);
      if (response.error) {
        const err = new Error(response.error.message ?? "ACP error");
        Object.assign(err, {
          code: response.error.code,
          data: response.error.data
        });
        waiter.reject(err);
      } else {
        waiter.resolve(response.result);
      }
      return;
    }
    if (message && typeof message === "object" && "method" in message) {
      events.emit("notification", /** @type {JsonRpcNotification} */ (message));
    }
  });

  transport.onHealthChange((state) => {
    events.emit("health", state);
    // worker_missing means the transport's child died (or never started).
    // Any pending requests will now wait forever for a response that
    // can't arrive — reject them so callers can fail fast and propagate
    // the error up their try/catch instead of timing out at the caller.
    if (state === "worker_missing") {
      for (const [, waiter] of pending) {
        waiter.reject(new Error("ACP transport worker missing — child exited or failed to spawn"));
      }
      pending.clear();
    }
  });

  return {
    async start() {
      await transport.start();
    },
    async request(method, params) {
      if (!transport.isOpen()) {
        throw new Error(`ACP request "${method}" on closed transport`);
      }
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      transport.send({ jsonrpc: "2.0", id, method, params });
      return /** @type {any} */ (promise);
    },
    notify(method, params) {
      if (!transport.isOpen()) {
        throw new Error(`ACP notify "${method}" on closed transport`);
      }
      transport.send({ jsonrpc: "2.0", method, params });
    },
    onNotification(handler) {
      events.on("notification", handler);
      return () => events.off("notification", handler);
    },
    onHealthChange(handler) {
      events.on("health", handler);
      return () => events.off("health", handler);
    },
    healthState() {
      return transport.healthState();
    },
    async close() {
      // Reject any in-flight requests so awaiters don't hang.
      for (const [, waiter] of pending) {
        waiter.reject(new Error("ACP transport closed with pending request"));
      }
      pending.clear();
      await transport.close();
    },
    isOpen() {
      return transport.isOpen();
    }
  };
}
