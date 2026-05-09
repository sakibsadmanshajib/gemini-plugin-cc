/**
 * ACP (Agent Client Protocol) type vocabulary.
 *
 * This file defines the JSDoc typedefs every transport, backend, and client
 * implementation conforms to. The validator behind these types is the
 * conformance suite in `lib/test-utils/conformance.mjs` — types here pin
 * the **shape**, the suite pins the **behavior**.
 *
 * The vocabulary follows the protocol surface captured in the
 * `gemini-plugin-baseline` capability spec at commit `f8f773c`:
 *
 *   - `initialize`, `authenticate`
 *   - `session/{new,load,set_mode,set_model,prompt,cancel}`
 *   - server-emitted `session/update` and `broker/diagnostic` notifications
 *
 * Adding a new method or notification at this layer is a breaking change for
 * every downstream conformer; gate it on a v2 spec delta.
 */

/**
 * @typedef {object} JsonRpcRequest
 * @property {"2.0"} jsonrpc
 * @property {number | string} id
 * @property {string} method
 * @property {object} [params]
 *
 * @typedef {object} JsonRpcResponse
 * @property {"2.0"} jsonrpc
 * @property {number | string} id
 * @property {any} [result]
 * @property {{ code: number, message: string, data?: any }} [error]
 *
 * @typedef {object} JsonRpcNotification
 * @property {"2.0"} jsonrpc
 * @property {string} method
 * @property {object} [params]
 *
 * @typedef {JsonRpcRequest | JsonRpcResponse | JsonRpcNotification} JsonRpcMessage
 */

/**
 * Server → client session-update notification body.
 *
 * @typedef {object} SessionUpdate
 * @property {"agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "file_change" | string} sessionUpdate
 * @property {{ text?: string }} [content]
 * @property {string} [toolName]
 * @property {string} [name]
 * @property {string} [path]
 * @property {string} [action]
 */

/**
 * Server-initiated permission request shape (reserved for future server→client
 * use; the gemini-plugin-baseline at f8f773c handles zero of these).
 *
 * @typedef {object} PermissionRequest
 * @property {string} sessionId
 * @property {string} kind
 * @property {object} [details]
 *
 * @typedef {object} PermissionResponse
 * @property {boolean} granted
 * @property {string} [reason]
 */

/**
 * Health label taxonomy. Transports report one of these via their
 * `healthState` accessor; the runtime renders to status output. Add a new
 * label only when the transition state is genuinely new — duplicate labels
 * with subtly different meanings make `/<backend>:status` unreadable.
 *
 * @typedef {"queued" | "active" | "quiet" | "possibly_stalled" | "rate_limited" | "auth_required" | "broker_unhealthy" | "worker_missing" | "completed" | "failed" | "cancelled"} HealthState
 */

/**
 * The single contract every transport, backend, and mock implements.
 *
 * Implementations MUST be drop-in interchangeable from the runtime's
 * perspective: same lifecycle, same method set, same error envelope shape.
 * The conformance suite validates this empirically.
 *
 * @typedef {object} AcpSession
 * @property {() => Promise<void>} start - Open the session (spawn subprocess, connect socket, etc.). Idempotent: a second start on a started session is a no-op.
 * @property {<T = any>(method: string, params?: object) => Promise<T>} request - Send a JSON-RPC request, await the matching response. Throws if the session isn't started or the response is an error envelope.
 * @property {(method: string, params?: object) => void} notify - Send a JSON-RPC notification (no `id`, no awaited response).
 * @property {(handler: (notification: JsonRpcNotification) => void) => () => void} onNotification - Register a server-notification handler; returns an unsubscribe function.
 * @property {(handler: (state: HealthState) => void) => () => void} onHealthChange - Register a health-transition handler; returns an unsubscribe function.
 * @property {() => HealthState} healthState - Current health label.
 * @property {() => Promise<void>} close - Tear down the session. Idempotent: a second close on a closed session is a no-op.
 * @property {() => boolean} isOpen - Whether the session is currently open and able to send/receive.
 */

// Re-export for ergonomic import-from-types in callsites that want symbols
// rather than `import type`-style references. No runtime values — types only.
export {};
