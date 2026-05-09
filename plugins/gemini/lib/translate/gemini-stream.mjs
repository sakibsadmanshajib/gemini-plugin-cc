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
    case "message": {
      // Gemini CLI 0.38+ emits chat-style {type:"message", role, content}
      // events. role:"user" is the echoed prompt — drop. role:"assistant"
      // (or "model") is the answer — surface as agent_message_chunk.
      // role:"reasoning"/"thought" — surface as agent_thought_chunk.
      // `content` is a plain string in this shape, not the {text} object
      // form used by the older event taxonomy.
      const role = String(/** @type {any} */ (update).role ?? "");
      if (role === "user" || role === "system") return null;
      const text =
        typeof (/** @type {any} */ (update).content) === "string"
          ? /** @type {any} */ (update).content
          : (update.content?.text ?? update.text ?? null);
      if (typeof text !== "string" || text === "") return null;
      const sessionUpdate =
        role === "reasoning" || role === "thought" ? "agent_thought_chunk" : "agent_message_chunk";
      return { sessionUpdate, content: { text } };
    }
    case "result": {
      // Gemini CLI 0.38+ emits a {type:"result", status, stats} terminal
      // event in place of the older `turn_completed`. Translate to the
      // canonical shape so consumers don't need to special-case.
      /** @type {SessionUpdate} */
      const out = { sessionUpdate: "turn_completed" };
      const u = /** @type {any} */ (update);
      if (u.status) out.reason = String(u.status);
      if (u.stats && typeof u.stats === "object") out.usage = { ...u.stats };
      // Gemini reports the actual model id inside stats.models. We pick
      // the first entry as the canonical model for cost-attribution.
      const firstModel =
        u.stats?.models && typeof u.stats.models === "object"
          ? Object.keys(u.stats.models)[0]
          : null;
      if (firstModel) out.model = firstModel;
      return out;
    }
    case "init":
      // Session-start event with session_id + model. Not an ACP-visible
      // update kind; runners read model directly off the result event.
      return null;
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
