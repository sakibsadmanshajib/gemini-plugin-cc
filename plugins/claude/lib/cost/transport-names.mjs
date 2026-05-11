/**
 * Cost-record transport enum — single source of truth for the string
 * literals that describe HOW a turn reached its backend. Mirrors the
 * pattern of `lib/backends/names.mjs::BACKEND_NAMES`.
 *
 * Use members of `TRANSPORT_NAMES` instead of the bare string literals
 * so a typo gets caught at typecheck time and the set of valid names
 * lives in one place. The JSDoc union below narrows to the actual
 * value type, mirroring the BackendName pattern.
 *
 * Values are intentionally kebab-case strings because they're written
 * verbatim into the cost.jsonl log file and consumed by external
 * tooling (`artagon-stats`, etc.). Renaming any value is a wire-format
 * break and requires a migration of existing log files.
 */

/**
 * @typedef {(
 *   | "cli"
 *   | "broker"
 *   | "facade"
 *   | "acp-server"
 *   | "codex-app-server"
 *   | "claude-agent-acp"
 * )} TransportName
 */

/**
 * @type {Readonly<{
 *   CLI: TransportName,
 *   BROKER: TransportName,
 *   FACADE: TransportName,
 *   ACP_SERVER: TransportName,
 *   CODEX_APP_SERVER: TransportName,
 *   CLAUDE_AGENT_ACP: TransportName
 * }>}
 */
export const TRANSPORT_NAMES = Object.freeze({
  /** Cold-start subprocess (today's default for one-shot runners). */
  CLI: /** @type {TransportName} */ ("cli"),
  /** Connected to a long-running gemini `--acp` broker via Unix socket. */
  BROKER: /** @type {TransportName} */ ("broker"),
  /** Routed through artagon-openai-server (cache-friendly). */
  FACADE: /** @type {TransportName} */ ("facade"),
  /**
   * Routed through artagon-acp-server OR the gemini streaming runner
   * that owns its own ACP session over the legacy broker socket.
   */
  ACP_SERVER: /** @type {TransportName} */ ("acp-server"),
  /**
   * `codex app-server` JSON-RPC 2.0 — codex's own `thread/turn/item`
   * schema, NOT Zed's ACP wire format. Kept distinct so per-backend
   * warm-path latency stays separable in aggregations.
   */
  CODEX_APP_SERVER: /** @type {TransportName} */ ("codex-app-server"),
  /**
   * `@agentclientprotocol/claude-agent-acp` — Zed's ACP wrapper around
   * the Claude Agent SDK. Wire format IS standard ACP; label is
   * distinct because the underlying auth + tool surface differs from
   * the `claude` CLI path.
   */
  CLAUDE_AGENT_ACP: /** @type {TransportName} */ ("claude-agent-acp")
});

/**
 * Type guard: is `value` one of the known transport names?
 *
 * @param {unknown} value
 * @returns {value is TransportName}
 */
export function isTransportName(value) {
  return (
    value === TRANSPORT_NAMES.CLI ||
    value === TRANSPORT_NAMES.BROKER ||
    value === TRANSPORT_NAMES.FACADE ||
    value === TRANSPORT_NAMES.ACP_SERVER ||
    value === TRANSPORT_NAMES.CODEX_APP_SERVER ||
    value === TRANSPORT_NAMES.CLAUDE_AGENT_ACP
  );
}
