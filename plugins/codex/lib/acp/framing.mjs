/**
 * Newline-delimited JSON-RPC framing.
 *
 * The wire is `JSON\n` — every JSON-RPC message is serialized to a single line
 * and terminated with `\n`. Receivers split incoming bytes on `\n`, parse each
 * non-empty line as JSON, and ignore parse failures (silent drop matches the
 * gemini-plugin-baseline `ACP Method Surface` requirement scenario at
 * commit `f8f773c`).
 *
 * The two helpers here are the inverse of each other and form the only
 * sanctioned framing surface. New transports MUST go through these — any
 * direct `JSON.parse` / `JSON.stringify` usage in transport code bypasses the
 * line buffer and will silently drop fragments.
 */

/**
 * Frame a JSON-RPC message for transmission.
 *
 * @param {import("./types.mjs").JsonRpcMessage} message
 * @returns {string}
 */
export function frame(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Stateful line buffer. Maintains a partial-line carry across reads so a
 * chunked stream still produces complete JSON frames. Consumers feed raw
 * bytes via `feed` and read parsed messages via the returned iterator.
 *
 * The buffer never throws on malformed JSON — the caller decides whether
 * to drop or surface. (`parseLines` below is the lenient default.)
 *
 * @returns {{ feed: (chunk: string) => Iterable<string>, drain: () => string | null }}
 */
export function createLineBuffer() {
  let carry = "";

  return {
    *feed(chunk) {
      const combined = carry + chunk;
      const parts = combined.split("\n");
      // The last element is either a complete final line (when the chunk
      // ended with `\n`, in which case it's empty) or an incomplete tail
      // we hold for the next chunk.
      carry = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    },
    drain() {
      const tail = carry.trim();
      carry = "";
      return tail || null;
    }
  };
}

/**
 * Parse a buffer of newline-delimited JSON into messages. Skips empty
 * lines and silently drops any line that fails JSON parsing — matches
 * runtime behavior at `acp-broker.mjs::handleAcpLine` and
 * `acp-client.mjs::handleLine`.
 *
 * Useful for one-shot parsing of a known-complete buffer (e.g., wire-log
 * replay). For streaming reads, use `createLineBuffer` to handle partial
 * lines correctly.
 *
 * @param {string} buffer
 * @returns {import("./types.mjs").JsonRpcMessage[]}
 */
export function parseLines(buffer) {
  /** @type {import("./types.mjs").JsonRpcMessage[]} */
  const out = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Silent drop. Wire log captures the raw bytes; debug there.
    }
  }
  return out;
}
