/**
 * Scriptable fake ACP backend.
 *
 * Pairs with `createPairedTransport`'s `server` half. Tests register handlers
 * for inbound requests (e.g., `initialize`, `session/new`, `session/prompt`)
 * and can push notifications (e.g., `session/update`) at will.
 *
 * Default behavior (when no handler is registered for a method): respond with
 * a JSON-RPC error `-32601 method not found`. This matches strict ACP server
 * behavior and surfaces test omissions loudly.
 */

/**
 * @typedef {(params: any) => any | Promise<any>} RequestHandler
 *
 * @typedef {{
 *   onRequest(method: string, handler: RequestHandler): void,
 *   notify(method: string, params: object): void,
 *   inboundLog: ReadonlyArray<{ method: string, params: any, id?: number | string | null }>,
 *   close(): void
 * }} FakeAcpBackend
 */

const DEFAULT_NOT_FOUND_CODE = -32601;

/**
 * Wire a fake ACP backend onto a transport half.
 *
 * @param {import("./in-memory-transport.mjs").TransportHalf} transport
 * @returns {FakeAcpBackend}
 */
export function createFakeAcpBackend(transport) {
  /** @type {Map<string, RequestHandler>} */
  const handlers = new Map();
  /** @type {Array<{ method: string, params: any, id?: number | string | null }>} */
  const inboundLog = [];

  const dispatch = async (message) => {
    const { id, method, params } = message ?? {};
    if (!method) return; // Not a request/notification we handle.

    inboundLog.push({ method, params, id: id ?? null });

    // Notifications: no response.
    if (id == null) {
      const handler = handlers.get(method);
      if (handler) {
        try {
          await handler(params);
        } catch {
          // Notifications can't error back; swallow.
        }
      }
      return;
    }

    // Requests: produce a response (or error if no handler).
    const handler = handlers.get(method);
    if (!handler) {
      transport.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: DEFAULT_NOT_FOUND_CODE,
          message: `Method not found: ${method}`
        }
      });
      return;
    }

    try {
      const result = await handler(params);
      transport.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      transport.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message }
      });
    }
  };

  transport.on("line", dispatch);

  return {
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    notify(method, params) {
      transport.write({ jsonrpc: "2.0", method, params });
    },
    inboundLog,
    close() {
      transport.close();
    }
  };
}
