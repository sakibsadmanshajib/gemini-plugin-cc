/**
 * Stderr stream handler factory for foreground ACP runs.
 *
 * Two modes:
 *  - "markers": compact one-line-per-event markers
 *  - "passthrough": raw chunk text, with "thought: " prefix on thought chunks
 *
 * json=true suppresses markers mode (keeps stdout JSON clean) but still
 * allows passthrough mode (user opted in explicitly).
 */

export const STREAM_MODES = ["markers", "passthrough"];

const MODE_SET = new Set(STREAM_MODES);

/**
 * @typedef {Object} StreamEventPhase
 * @property {"phase"} type
 * @property {string} message
 *
 * @typedef {Object} StreamEventTool
 * @property {"tool_call"} type
 * @property {string} toolName
 *
 * @typedef {Object} StreamEventMessage
 * @property {"message_chunk"} type
 * @property {string} text
 *
 * @typedef {Object} StreamEventThought
 * @property {"thought_chunk"} type
 * @property {string} text
 *
 * @typedef {Object} StreamEventFile
 * @property {"file_change"} type
 * @property {string} path
 * @property {string} action
 *
 * @typedef {Object} StreamEventDone
 * @property {"done"} type
 * @property {{ tools: number, files: number, chunks: number, thoughts: number, elapsedMs: number }} stats
 *
 * @typedef {StreamEventPhase|StreamEventTool|StreamEventMessage|StreamEventThought|StreamEventFile|StreamEventDone} StreamEvent
 */

function safeWrite(writer, data) {
  try {
    writer(data);
  } catch (error) {
    if (error && (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")) {
      return;
    }
    throw error;
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * @param {{ mode: string, json: boolean, writer: (s: string) => any }} opts
 * @returns {(event: StreamEvent) => void}
 */
export function createStreamHandler({ mode, json, writer }) {
  if (!MODE_SET.has(mode)) {
    throw new Error(`Invalid stream mode: ${mode}. Expected one of ${STREAM_MODES.join(", ")}.`);
  }

  const suppressMarkers = mode === "markers" && json === true;

  return function handle(event) {
    if (!event || typeof event !== "object") return;
    if (suppressMarkers) return;

    if (mode === "passthrough") {
      if (event.type === "message_chunk" && typeof event.text === "string") {
        safeWrite(writer, event.text);
        return;
      }
      if (event.type === "thought_chunk" && typeof event.text === "string") {
        safeWrite(writer, `thought: ${event.text}\n`);
        return;
      }
      return;
    }

    // markers mode
    switch (event.type) {
      case "phase": {
        const raw = event.message ?? "";
        const isSession = raw.startsWith("session_");
        const label = isSession ? "session" : "phase";
        const msg = isSession ? raw.replace(/^session_/, "") : raw;
        safeWrite(writer, `[${label}] ${msg}\n`);
        return;
      }
      case "tool_call":
        safeWrite(writer, `[tool] ${event.toolName ?? "unknown"}\n`);
        return;
      case "message_chunk":
        safeWrite(writer, ".");
        return;
      case "thought_chunk":
        safeWrite(writer, "[thinking]\n");
        return;
      case "file_change":
        safeWrite(writer, `[file] ${event.action ?? "modify"} ${event.path ?? ""}\n`);
        return;
      case "done": {
        const s = event.stats ?? {};
        const parts = [
          formatElapsed(s.elapsedMs ?? 0),
          plural(s.tools ?? 0, "tool"),
          plural(s.files ?? 0, "file"),
          plural(s.chunks ?? 0, "chunk"),
          plural(s.thoughts ?? 0, "thought")
        ];
        safeWrite(writer, `[done] ${parts.join(" | ")}\n`);
        return;
      }
      default:
        return;
    }
  };
}
