/**
 * Translate `gemini -p <prompt> -o stream-json` events to ACP
 * `session/update` notifications.
 *
 * Gemini's stream-json output is the closest of the three CLIs to
 * already-ACP shape — its event kinds (`agent_message_chunk`,
 * `agent_thought_chunk`, `tool_call`, `file_change`, `turn_completed`)
 * are the same names ACP uses for `session/update.update.sessionUpdate`.
 * The translator is therefore mostly a pass-through; its job is to:
 *
 *   1. Unwrap JSON-RPC envelopes (`{jsonrpc, method, params: {update}}`)
 *      when gemini emits the wire-style shape.
 *   2. Pass through bare event shapes (`{sessionUpdate, content, ...}`)
 *      unchanged.
 *   3. Drop events that don't have an ACP equivalent (system/debug, or
 *      malformed shapes) — return null as the drift signal.
 *
 * Documented event taxonomy: `docs/cli-options-research.md`. Gemini's
 * `--acp` mode produces ACP wire format directly; `-o stream-json` emits
 * the same kinds via line-delimited JSON.
 */

/**
 * @typedef {{
 *   sessionUpdate?: string,
 *   content?: { text?: string },
 *   text?: string,
 *   toolName?: string,
 *   name?: string,
 *   toolUseId?: string,
 *   args?: any,
 *   result?: any,
 *   isError?: boolean,
 *   reason?: string,
 *   usage?: any,
 *   path?: string,
 *   action?: string
 * } & Record<string, unknown>} GeminiUpdate
 *
 * @typedef {{
 *   jsonrpc?: string,
 *   method?: string,
 *   params?: { update?: GeminiUpdate, sessionId?: string },
 *   type?: string
 * } & GeminiUpdate} GeminiStreamEvent
 *
 * @typedef {{
 *   sessionUpdate: string,
 *   content?: { text: string },
 *   toolName?: string,
 *   toolUseId?: string,
 *   args?: any,
 *   result?: any,
 *   isError?: boolean,
 *   reason?: string,
 *   usage?: any,
 *   model?: string | null
 * }} SessionUpdate
 */

/**
 * @param {GeminiStreamEvent} event
 * @returns {SessionUpdate | null}
 */
export function translateGeminiStreamEvent(event) {
  if (!event || typeof event !== "object") return null;

  // Wire-style JSON-RPC envelope: { jsonrpc, method: "session/update",
  // params: { sessionId, update } }. Unwrap to the inner update.
  const update =
    event.method === "session/update" && event.params?.update
      ? event.params.update
      : /** @type {GeminiUpdate} */ (event);

  // Translate the inner shape. Some emitters use `sessionUpdate` (ACP
  // canonical), others use a bare `type` field — accept both.
  const kind = update.sessionUpdate ?? update.type;
  if (typeof kind !== "string") return null;

  switch (kind) {
    case "agent_message_chunk":
      return makeChunk("agent_message_chunk", update);
    case "agent_thought_chunk":
      return makeChunk("agent_thought_chunk", update);
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolName: String(update.toolName ?? update.name ?? "unknown"),
        toolUseId: String(update.toolUseId ?? ""),
        args: update.args ?? {}
      };
    case "tool_result":
      return {
        sessionUpdate: "tool_result",
        toolUseId: String(update.toolUseId ?? ""),
        result: update.result ?? null,
        isError: Boolean(update.isError)
      };
    case "turn_completed": {
      /** @type {SessionUpdate} */
      const out = { sessionUpdate: "turn_completed" };
      if (update.reason) out.reason = String(update.reason);
      if (update.usage && typeof update.usage === "object") {
        out.usage = { ...update.usage };
      }
      // Capture model id when reported. Gemini's --output-format json
      // surfaces it as `model` on the turn record; some legacy emitters
      // place it in `model_version`.
      const u = /** @type {any} */ (update);
      const model = u.model ?? u.modelVersion ?? u.model_version ?? null;
      if (model) out.model = String(model);
      return out;
    }
    case "file_change":
      // file_change is a Gemini-specific shape that isn't in the ACP
      // session/update enum — return null so the runner doesn't
      // accumulate it as text. Callers wanting per-file changes parse
      // them out of `updates[]` explicitly.
      return null;
    default:
      return null;
  }
}

/**
 * Extract the text content from either canonical `{content: {text}}` or
 * a bare `{text}` shape; return null when neither is present.
 *
 * @param {string} sessionUpdate
 * @param {GeminiUpdate} update
 * @returns {SessionUpdate | null}
 */
function makeChunk(sessionUpdate, update) {
  const text = update.content?.text ?? update.text ?? null;
  if (typeof text !== "string" || text === "") return null;
  return { sessionUpdate, content: { text } };
}
