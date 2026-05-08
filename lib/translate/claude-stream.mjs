/**
 * Translate `claude --print --output-format=stream-json` events to ACP
 * `session/update` notifications.
 *
 * Pure function — `(streamJsonEvent) => SessionUpdate[] | null`. Returns
 * an array because a single Claude event can carry multiple content
 * blocks (an `assistant` event with text + thinking + tool_use yields
 * three ACP updates). Returns null for events that don't have a
 * meaningful ACP equivalent (debug/system events, or shapes the
 * upstream Claude CLI invented after this translator was written).
 *
 * Event taxonomy is documented in `docs/cli-options-research.md`. Claude's
 * `stream-json` output emits one JSON event per line on stdout; common
 * shapes:
 *
 *   - `assistant` with `message.content[]` blocks of `{type: "text"}`,
 *     `{type: "thinking"}`, or `{type: "tool_use"}`
 *   - `user` with `message.content[]` blocks of `{type: "tool_result"}`
 *   - `result` with `subtype: "success" | "error_max_turns" | ...`,
 *     `usage`, `duration_ms`, `total_cost_usd`
 *   - `system` with `subtype: "init" | "compact_boundary" | ...` (debug-only)
 *
 * The translator is conservative: we map only what we can name; everything
 * else returns null.
 */

/**
 * @typedef {{
 *   type: string,
 *   message?: { content?: any[], role?: string, stop_reason?: string, usage?: any, model?: string },
 *   subtype?: string,
 *   usage?: { input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number },
 *   duration_ms?: number,
 *   total_cost_usd?: number,
 *   stop_reason?: string,
 *   session_id?: string
 * } & Record<string, unknown>} ClaudeStreamEvent
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
 *   usage?: any
 * }} SessionUpdate
 */

/**
 * @param {ClaudeStreamEvent} event
 * @returns {SessionUpdate[] | null}
 */
export function translateClaudeStreamEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return null;
  }

  switch (event.type) {
    case "assistant":
      return translateAssistant(event);
    case "user":
      return translateUser(event);
    case "result":
      return translateResult(event);
    case "system":
      // system events (init, compact_boundary, etc.) are debug-only — Claude
      // emits these for the host's awareness, not for downstream agents.
      return null;
    default:
      return null;
  }
}

/**
 * @param {ClaudeStreamEvent} event
 * @returns {SessionUpdate[] | null}
 */
function translateAssistant(event) {
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return null;

  /** @type {SessionUpdate[]} */
  const updates = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const t = /** @type {any} */ (block).type;
    if (t === "text") {
      const text = String(/** @type {any} */ (block).text ?? "");
      if (text)
        updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { text }
        });
    } else if (t === "thinking") {
      const text = String(
        /** @type {any} */ (block).thinking ?? /** @type {any} */ (block).text ?? ""
      );
      if (text)
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          content: { text }
        });
    } else if (t === "tool_use") {
      const b = /** @type {any} */ (block);
      updates.push({
        sessionUpdate: "tool_call",
        toolName: String(b.name ?? "unknown"),
        toolUseId: String(b.id ?? ""),
        args: b.input ?? {}
      });
    }
    // Other block types (image, document, etc.) silently skip — the
    // null/empty array result tells callers nothing meaningful happened.
  }

  return updates.length ? updates : null;
}

/**
 * Claude `user` events typically carry `tool_result` blocks (the tool
 * harness echoes results back into the conversation as user-role messages).
 *
 * @param {ClaudeStreamEvent} event
 * @returns {SessionUpdate[] | null}
 */
function translateUser(event) {
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return null;

  /** @type {SessionUpdate[]} */
  const updates = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = /** @type {any} */ (block);
    if (b.type === "tool_result") {
      updates.push({
        sessionUpdate: "tool_result",
        toolUseId: String(b.tool_use_id ?? ""),
        result: extractText(b.content) ?? b.content ?? null,
        isError: Boolean(b.is_error)
      });
    }
    // Plain user text isn't translated — the runtime sent that prompt; the
    // echo is informational.
  }

  return updates.length ? updates : null;
}

/**
 * @param {ClaudeStreamEvent} event
 * @returns {SessionUpdate[] | null}
 */
function translateResult(event) {
  /** @type {SessionUpdate} */
  const update = { sessionUpdate: "turn_completed" };
  if (event.subtype) update.reason = String(event.subtype);
  else if (event.stop_reason) update.reason = String(event.stop_reason);

  if (event.usage && typeof event.usage === "object") {
    // Pass usage through verbatim — Claude's shape (input_tokens,
    // output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
    // is richer than what the cost middleware needs but doesn't conflict.
    update.usage = { ...event.usage };
  }

  return [update];
}

/**
 * Extract a text string from Claude's polymorphic content shape. Content
 * can be a plain string, an array of `{type: "text", text}` blocks, or
 * null.
 *
 * @param {unknown} content
 * @returns {string | null}
 */
function extractText(content) {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && typeof b === "object" && /** @type {any} */ (b).type === "text")
      .map((b) => /** @type {any} */ (b).text)
      .filter((t) => typeof t === "string");
    return parts.length ? parts.join("") : null;
  }
  return null;
}
