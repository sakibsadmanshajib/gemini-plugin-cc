/**
 * In-memory paired transport for ACP testing.
 *
 * Two halves of a transport that talk to each other in-process. The "client"
 * half is the side under test; the "server" half is a stand-in for the real
 * `gemini --acp` (or any future ACP server). Each side emits "line" events
 * for incoming JSON-RPC frames and exposes `write(message)` to send.
 *
 * This is the core primitive for `fake-acp-backend.mjs` and for fixture
 * replay. It avoids spawning a real subprocess for tests that only care
 * about the wire-protocol contract.
 */

import { EventEmitter } from "node:events";

/**
 * @typedef {{
 *   write(message: object): void,
 *   on(event: "line", handler: (message: object) => void): void,
 *   on(event: "close", handler: () => void): void,
 *   off(event: string, handler: (...args: any[]) => void): void,
 *   close(): void,
 *   readonly closed: boolean
 * }} TransportHalf
 */

class TransportHalfImpl extends EventEmitter {
  /**
   * @param {string} label - "client" or "server" for diagnostic output.
   */
  constructor(label) {
    super();
    this.label = label;
    this.closed = false;
    /** @type {TransportHalfImpl | null} */
    this.peer = null;
  }

  /**
   * Send a JSON-RPC message to the peer. The message MUST be a plain object
   * (not a string); the transport handles framing internally.
   *
   * @param {object} message
   */
  write(message) {
    if (this.closed) {
      throw new Error(`Transport ${this.label} is closed; cannot write.`);
    }
    if (!this.peer || this.peer.closed) {
      throw new Error(`Transport ${this.label}'s peer is unavailable.`);
    }
    // Round-trip through JSON to mirror the real wire (catches non-serializable
    // payloads like undefined values, BigInts, circular refs).
    const wire = JSON.stringify(message);
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) {
        this.peer.emit("line", JSON.parse(wire));
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
    if (this.peer && !this.peer.closed) {
      this.peer.close();
    }
  }
}

/**
 * Create a paired transport. Returns `{ client, server }` — write() on one
 * causes a "line" event on the other.
 *
 * @returns {{ client: TransportHalf, server: TransportHalf }}
 */
export function createPairedTransport() {
  const client = new TransportHalfImpl("client");
  const server = new TransportHalfImpl("server");
  client.peer = server;
  server.peer = client;
  return { client, server };
}
