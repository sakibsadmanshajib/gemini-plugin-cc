/**
 * Streaming runner contract — shared interface for per-backend
 * long-lived runners that own one CLI subprocess and multiplex turns
 * through it.
 *
 * Each backend's streaming runner conforms to `StreamingRunner`. The
 * supervisor (`supervisor.mjs`) wraps each runner with lifecycle
 * (start/restart/idle-reap/health) so the per-backend code can focus on
 * the protocol details (gemini --acp / codex app-server / claude
 * --input-format stream-json).
 *
 * Health vocabulary (mirrors what the legacy gemini broker uses):
 *   - "starting"   → spawn issued, not yet ready for turns
 *   - "healthy"    → ready; runTurn() resolves cleanly
 *   - "degraded"   → recent turn(s) failed but child is alive
 *   - "restarting" → child died; restart in progress
 *   - "dead"       → exceeded max restart attempts; reject new turns
 *
 * Lifecycle invariants:
 *   - start() is idempotent — calling twice is the second a no-op
 *   - close() is idempotent — calling twice is the second a no-op
 *   - close() MUST be safe to call on a dead/restarting runner
 *   - runTurn() MUST reject (not throw synchronously) when health is dead
 *   - health() is sync and must never block on I/O
 */

/**
 * @typedef {"starting" | "healthy" | "degraded" | "restarting" | "dead"} StreamingHealth
 *
 * Redacted error classifier shared between the registry's
 * `getSupervisorStatuses()` and the `/admin/status` response. Closed
 * set so consumers can `switch` exhaustively and any contributor adding
 * a new code has to update the union (and any switch sites). The full
 * unredacted message stays in the daemon's stderr log; this is the
 * only thing reachable through the bearer-gated admin endpoint, which
 * is open when `apiKey` is unset and the operator binds to 0.0.0.0.
 *
 * @typedef {(
 *   | "spawn_not_found"
 *   | "spawn_denied"
 *   | "timeout"
 *   | "auth_failed"
 *   | "transport_closed"
 *   | "restart_budget_exhausted"
 *   | "session_init_failed"
 *   | "internal_error"
 *   | "introspect_failed"
 *   | "oom"
 *   | "unknown"
 * )} LastErrorCode
 *
 * @typedef {{
 *   prompt: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   model?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void
 * }} StreamingTurnOptions
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 *
 * The optional `lastError()` getter exposes the supervisor's last
 * captured error. Only the wrapping supervisor implements it; bare
 * per-backend runners may not. Callers must duck-type via
 * `typeof runner.lastError === "function"`.
 *
 * @typedef {{
 *   start(): Promise<void>,
 *   runTurn(
 *     options: StreamingTurnOptions,
 *     context?: import("#lib/agent-context.mjs").AgentContext
 *   ): Promise<TurnResult>,
 *   close(): Promise<void>,
 *   health(): StreamingHealth,
 *   lastError?(): Error | null
 * }} StreamingRunner
 *
 * @typedef {(env?: NodeJS.ProcessEnv) => StreamingRunner} StreamingRunnerFactory
 */

// This file is JSDoc-types-only. No runtime exports. The .mjs
// extension is required because TypeScript's allowJs option won't
// resolve `.d.mjs` JSDoc imports cleanly through the bundler-style
// moduleResolution we use.
export {};
