/**
 * MockBackend — reference `ClientTransport` implementation for tests and as
 * the executable definition of "what AcpSession-conformant means".
 *
 * Everything passes through in-process EventEmitter dispatch — no subprocess,
 * no network, no fixture file. Callers register request handlers and can
 * push notifications imperatively. The conformance suite in
 * `lib/test-utils/conformance.mjs` runs against this AND against `CliTransport`
 * to ensure they agree behaviorally.
 *
 * This is the layer to extend when you want to script complex backend
 * scenarios (rate limits, partial responses, mid-stream cancels) for unit
 * tests without paying subprocess startup cost.
 */

import { EventEmitter } from "node:events";

/**
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 * @typedef {import("../acp/types.mjs").HealthState} HealthState
 * @typedef {import("../acp/types.mjs").JsonRpcMessage} JsonRpcMessage
 *
 * @typedef {(params: any) => any | Promise<any>} MockRequestHandler
 *
 * @typedef {ClientTransport & {
 *   onRequest(method: string, handler: MockRequestHandler): void,
 *   pushNotification(method: string, params?: object): void,
 *   pushHealth(state: HealthState): void,
 *   inboundLog: ReadonlyArray<JsonRpcMessage>
 * }} MockBackend
 */

/**
 * @returns {MockBackend}
 */
export function createMockBackend() {
  const events = new EventEmitter();
  /** @type {Map<string, MockRequestHandler>} */
  const handlers = new Map();
  /** @type {JsonRpcMessage[]} */
  const inboundLog = [];

  let open = false;
  let starting = false;
  /** @type {HealthState} */
  let health = "queued";

  /** @param {HealthState} next */
  function setHealth(next) {
    health = next;
    events.emit("health", next);
  }

  return {
    async start() {
      if (open || starting) return;
      starting = true;
      open = true;
      starting = false;
      setHealth("active");
    },

    send(message) {
      if (!open) {
        throw new Error("MockBackend: send on closed transport");
      }
      inboundLog.push(message);
      // Schedule async dispatch so request callers see Promise semantics
      // (resolution doesn't synchronously fire inside `send`).
      queueMicrotask(() => dispatch(message));
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
      if (!open) return;
      open = false;
      setHealth("completed");
    },

    isOpen() {
      return open;
    },

    onRequest(method, handler) {
      handlers.set(method, handler);
    },

    pushNotification(method, params) {
      events.emit("message", { jsonrpc: "2.0", method, params: params ?? {} });
    },

    pushHealth(state) {
      setHealth(state);
    },

    inboundLog
  };

  /** @param {JsonRpcMessage} message */
  function dispatch(message) {
    const id = /** @type {any} */ (message).id;
    const method = /** @type {any} */ (message).method;
    const params = /** @type {any} */ (message).params;
    if (!method) return; // Responses from the client side are not expected.

    if (id === undefined || id === null) {
      // Notification: no response.
      const handler = handlers.get(method);
      if (handler) {
        Promise.resolve()
          .then(() => handler(params))
          .catch((err) => {
            // JSON-RPC notifications can't return errors back to the
            // caller. Surface to stderr so a thrown handler doesn't
            // silently pass under a green test — without this the
            // failure shows up as a hard-to-debug stalled assertion.
            process.stderr.write(
              `[mock-backend] notification handler "${method}" threw: ${
                err instanceof Error ? (err.stack ?? err.message) : String(err)
              }\n`
            );
          });
      }
      return;
    }

    const handler = handlers.get(method);
    if (!handler) {
      events.emit("message", {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
      return;
    }

    Promise.resolve()
      .then(() => handler(params))
      .then((result) => {
        events.emit("message", { jsonrpc: "2.0", id, result });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        events.emit("message", {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message }
        });
      });
  }
}
