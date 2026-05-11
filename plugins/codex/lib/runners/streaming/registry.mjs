/**
 * Streaming runner registry — module-scoped lazy supervisors keyed by
 * (backend, cwd). The first call to `getStreamingRunner(backend, cwd)`
 * creates a fresh supervisor; subsequent calls return the same instance
 * so the underlying CLI subprocess / ACP connection is reused.
 *
 * Why module-scoped (not per-call-site or per-options):
 *   - The whole point of streaming is "keep one process open across
 *     turns". A new supervisor per call would defeat that.
 *   - The dispatcher is the only place in lib/ that constructs
 *     supervisors today; isolating the singleton store here keeps the
 *     dispatch surface narrow.
 *
 * Tests reset the store via `_resetStreamingRegistryForTest()`.
 *
 * @typedef {import("./types.mjs").StreamingRunner} StreamingRunner
 * @typedef {import("#lib/backends/names.mjs").BackendName} BackendName
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";

import { createClaudeStreamingRunner } from "./claude-streaming.mjs";
import { createCodexStreamingRunner } from "./codex-streaming.mjs";
import { createGeminiStreamingRunner } from "./gemini-streaming.mjs";
import { createSupervisor } from "./supervisor.mjs";

/** @type {Map<string, StreamingRunner>} */
const supervisors = new Map();

/**
 * Get (or lazily create) the streaming supervisor for the given
 * backend + cwd. All three backends are wired today; returns null
 * only for unknown backend names.
 *
 * @param {BackendName} backend
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   idleMs?: number,
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * }} [opts]
 *   `context` is plumbed through to factoryFor (Phase 2) but per the
 *   design the supervisor caches per (backend, cwd) — context is then
 *   threaded per-turn via `runTurn(opts, context)` instead of frozen
 *   at supervisor-construction time. Wire-log path is the documented
 *   exception (captured at construction).
 * @returns {StreamingRunner | null}
 */
export function getStreamingRunner(backend, opts = {}) {
  const cwd = opts.context?.cwd ?? opts.cwd ?? process.cwd();
  const key = `${backend}::${cwd}`;
  const cached = supervisors.get(key);
  if (cached) return cached;

  const factory = factoryFor(backend, {
    cwd,
    env: opts.context?.env ?? opts.env,
    context: opts.context
  });
  if (!factory) return null;

  const supervisor = createSupervisor({
    factory,
    idleMs: opts.idleMs,
    onWarning: (msg) => {
      process.stderr.write(`[streaming:${backend}] ${msg}\n`);
    }
  });
  supervisors.set(key, supervisor);
  return supervisor;
}

/**
 * Backend → runner-factory dispatch.
 *   GEMINI  → connects to the existing `gemini --acp` broker socket.
 *   CODEX   → spawns `codex app-server` directly via the inline
 *             translator in `codex-streaming.mjs`.
 *   CLAUDE  → spawns `@agentclientprotocol/claude-agent-acp` (Zed's
 *             ACP server backed by the Claude Agent SDK). Auth uses
 *             whatever credentials the host already has (claude login
 *             session or ANTHROPIC_API_KEY).
 *
 * @param {BackendName} backend
 * @param {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * }} ctx
 * @returns {(() => StreamingRunner) | null}
 */
function factoryFor(backend, ctx) {
  switch (backend) {
    case BACKEND_NAMES.GEMINI:
      return () => createGeminiStreamingRunner({ cwd: ctx.cwd, env: ctx.env });
    case BACKEND_NAMES.CODEX:
      return () => createCodexStreamingRunner({ cwd: ctx.cwd, env: ctx.env });
    case BACKEND_NAMES.CLAUDE:
      return () => createClaudeStreamingRunner({ cwd: ctx.cwd, env: ctx.env });
    default:
      return null;
  }
}

/**
 * Close + drop every cached supervisor. Used by tests; also safe to
 * call from a process-exit handler if a host wants to reap streaming
 * runners cleanly.
 *
 * @returns {Promise<void>}
 */
export async function shutdownAllStreamingRunners() {
  const entries = Array.from(supervisors.values());
  supervisors.clear();
  await Promise.all(
    entries.map((s) =>
      s.close().catch(() => {
        // best-effort during shutdown
      })
    )
  );
}

/**
 * Test-only: forget all cached supervisors WITHOUT closing them. Use
 * this when the underlying transport / client are mocks that don't
 * need real cleanup.
 *
 * @internal
 */
export function _resetStreamingRegistryForTest() {
  supervisors.clear();
}
