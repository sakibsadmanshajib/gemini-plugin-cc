/**
 * Translate `codex exec --json` stream-json events to ACP `session/update`
 * notifications.
 *
 * Pure function — `(streamJsonEvent) => SessionUpdate | null`. Returns null
 * for events that don't have a meaningful ACP equivalent (debug/system
 * events, or shapes the upstream codex CLI invented after this translator
 * was written). Callers SHOULD count nulls and emit a `degraded_mode`
 * metric — text streaming continues to work, but tool calls and rich
 * features may go missing on drift.
 *
 * Event taxonomy is documented in `docs/cli-options-research.md`. Codex's
 * `exec --json` emits one JSON event per line on stdout; common shapes:
 *
 *   - `item.created` with `item.type` of `assistant_message`, `reasoning`,
 *     `tool_call`, or `tool_result`
 *   - `exec_command.started` / `exec_command.output` / `exec_command.completed`
 *     for shell commands invoked by the agent
 *   - `turn.completed` with `usage` and `duration_ms`
 *
 * The translator is conservative: we map only what we can name; everything
 * else returns null. This trades coverage for predictability — a known
 * mapping is more valuable than a guessed mapping that might silently
 * misrepresent the agent's state.
 */

/**
 * @typedef {{
 *   type: string,
 *   item?: { type?: string, role?: string, content?: any, name?: string, arguments?: any, output?: any, is_error?: boolean, id?: string },
 *   command?: { id?: string, command?: string, args?: string[], cwd?: string },
 *   output?: { stdout?: string, stderr?: string, exit_code?: number },
 *   usage?: { input_tokens?: number, output_tokens?: number, total_tokens?: number },
 *   duration_ms?: number,
 *   stop_reason?: string
 * } & Record<string, unknown>} CodexStreamEvent
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
 *   usage?: { input_tokens: number, output_tokens: number }
 * }} SessionUpdate
 */

/**
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
export function translateCodexStreamEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return null;
  }

  switch (event.type) {
    case "item.created":
      return translateItemCreated(event);
    case "exec_command.started":
      return translateExecStarted(event);
    case "exec_command.output":
      return translateExecOutput(event);
    case "exec_command.completed":
      return translateExecCompleted(event);
    case "turn.completed":
      return translateTurnCompleted(event);
    default:
      // Unknown / debug events (system, error, item.updated, etc.). Return
      // null so the caller knows nothing is happening at the ACP layer.
      return null;
  }
}

/**
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
function translateItemCreated(event) {
  const item = event.item;
  if (!item || typeof item !== "object") return null;

  switch (item.type) {
    case "assistant_message":
    case "message": {
      const text = extractText(item.content);
      if (text == null) return null;
      // Codex distinguishes assistant role (visible) from reasoning (thought).
      // The runtime treats them as separate ACP update kinds.
      return item.role === "reasoning"
        ? { sessionUpdate: "agent_thought_chunk", content: { text } }
        : { sessionUpdate: "agent_message_chunk", content: { text } };
    }
    case "reasoning": {
      const text = extractText(item.content);
      if (text == null) return null;
      return { sessionUpdate: "agent_thought_chunk", content: { text } };
    }
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolName: String(item.name ?? "unknown"),
        toolUseId: String(item.id ?? ""),
        args: item.arguments ?? {}
      };
    case "tool_result":
      return {
        sessionUpdate: "tool_result",
        toolUseId: String(item.id ?? ""),
        result: item.output ?? null,
        isError: Boolean(item.is_error)
      };
    default:
      return null;
  }
}

/**
 * `exec_command.started` represents an agent-issued shell invocation. We
 * model this as a tool_call with the canonical `bash` toolName so consumers
 * get a uniform tool_call → tool_result pair regardless of whether the
 * call was a generic tool or a shell exec.
 *
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
function translateExecStarted(event) {
  const cmd = event.command;
  if (!cmd) return null;
  return {
    sessionUpdate: "tool_call",
    toolName: "bash",
    toolUseId: String(cmd.id ?? ""),
    args: {
      command: cmd.command ?? "",
      args: cmd.args ?? [],
      cwd: cmd.cwd ?? null
    }
  };
}

/**
 * Streaming partial output from a still-running shell command. We model
 * each chunk as an `agent_message_chunk` containing the stdout text — the
 * ACP consumer can correlate by previous tool_call timing if needed.
 *
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
function translateExecOutput(event) {
  const text = event.output?.stdout ?? event.output?.stderr ?? null;
  if (text == null || text === "") return null;
  return {
    sessionUpdate: "agent_message_chunk",
    content: { text: String(text) }
  };
}

/**
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
function translateExecCompleted(event) {
  const cmd = event.command;
  const output = event.output;
  if (!cmd || !output) return null;
  return {
    sessionUpdate: "tool_result",
    toolUseId: String(cmd.id ?? ""),
    result: {
      stdout: output.stdout ?? "",
      stderr: output.stderr ?? "",
      exitCode: output.exit_code ?? null
    },
    isError: typeof output.exit_code === "number" && output.exit_code !== 0
  };
}

/**
 * @param {CodexStreamEvent} event
 * @returns {SessionUpdate | null}
 */
function translateTurnCompleted(event) {
  /** @type {SessionUpdate} */
  const update = { sessionUpdate: "turn_completed" };
  if (event.stop_reason) update.reason = String(event.stop_reason);
  if (event.usage && typeof event.usage === "object") {
    update.usage = {
      input_tokens: Number(event.usage.input_tokens ?? 0),
      output_tokens: Number(event.usage.output_tokens ?? 0)
    };
  }
  return update;
}

/**
 * Extract a text string from Codex's `content` field. Content can be a
 * plain string, an array of `{type: "text", text}` blocks, or null.
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
