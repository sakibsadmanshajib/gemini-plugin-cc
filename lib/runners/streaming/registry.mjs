/**
 * Streaming runner registry — module-scoped lazy supervisors keyed by
 * `backend` ONLY. The first call to `getStreamingRunner(backend, ...)`
 * creates a fresh supervisor; subsequent calls return the same instance
 * so the underlying CLI subprocess / ACP connection is reused.
 *
 * **Cwd handling (F7).** The cache is NOT keyed by cwd. The first call
 * picks the subprocess's spawn cwd (the runner captures
 * `options.cwd ?? process.cwd()` at construction). Subsequent turns
 * with different per-turn cwds pass cwd through ACP `session/new` /
 * `thread/start` params — both codex app-server and claude-agent-acp
 * are designed for multi-workspace use over one process; per-session
 * cwd is the protocol contract. This trades "subprocess cwd matches
 * every turn's cwd" for "no spawn tax when developers cd between
 * repos" — the daemon's reason to exist.
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
  const cached = supervisors.get(backend);
  if (cached) {
    // F8: evict dead supervisors so the next call constructs a fresh
    // one. Without this, three transient crashes (e.g. flaky network
    // during auth refresh) permanently degrade the daemon to cold-
    // start. The supervisor's restart-budget protection still applies
    // inside each new instance — we just don't pin the dead instance.
    if (cached.health() === "dead") {
      // H5: surface the underlying cause when evicting a dead
      // supervisor, so operators see "auth expired" / "spawn ENOENT"
      // instead of just "evicting dead supervisor".
      const lastErr =
        typeof (/** @type {any} */ (cached).lastError) === "function"
          ? /** @type {any} */ (cached).lastError()
          : null;
      const cause = lastErr instanceof Error ? lastErr.message : null;
      process.stderr.write(
        `[streaming:${backend}] evicting dead supervisor` +
          (cause ? ` (last error: ${cause})` : "") +
          "\n"
      );
      supervisors.delete(backend);
      // G3: route close failures to stderr instead of swallowing.
      cached.close().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[streaming:${backend}] eviction close failed: ${message}\n`);
      });
    } else {
      return cached;
    }
  }

  // Subprocess spawn cwd: first caller's cwd wins for the supervisor's
  // lifetime. Per-turn cwds for later turns flow through session/new.
  const factoryCwd = opts.context?.cwd ?? opts.cwd ?? process.cwd();
  const factory = factoryFor(backend, {
    cwd: factoryCwd,
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
  supervisors.set(backend, supervisor);
  return supervisor;
}

/**
 * Backend → runner-factory dispatch. As of Step 2, all three streaming
 * runners spawn their CLI subprocess directly (no external broker):
 *   GEMINI  → spawns `gemini --acp` via createCliTransport.
 *   CODEX   → spawns `codex app-server --listen stdio://`.
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
  // The supervisor caches one runner per (backend, cwd). Wire-log
  // binding is captured at THIS construction time — the runner's
  // transport opens its log fd on `start()` using `ctx.context.logging`,
  // and subsequent turns reuse that binding. Changing `--wire-log` at
  // turn N>1 won't reconfigure the transport (documented limitation;
  // operators must `shutdownAllStreamingRunners()` to rebind).
  switch (backend) {
    case BACKEND_NAMES.GEMINI:
      return () =>
        createGeminiStreamingRunner({
          cwd: ctx.cwd,
          env: ctx.env,
          context: ctx.context
        });
    case BACKEND_NAMES.CODEX:
      return () =>
        createCodexStreamingRunner({
          cwd: ctx.cwd,
          env: ctx.env,
          context: ctx.context
        });
    case BACKEND_NAMES.CLAUDE:
      return () =>
        createClaudeStreamingRunner({
          cwd: ctx.cwd,
          env: ctx.env,
          context: ctx.context
        });
    default:
      return null;
  }
}

/**
 * Classify a supervisor's last-error into a short, redacted code
 * suitable for a remotely-readable /admin/status response.
 *
 * L3: the raw error message can contain absolute paths, env-derived
 * auth hints, or upstream API stack frames. /admin/status is reachable
 * unauthed when the operator hasn't configured `apiKey` (and the
 * default localhost-only bind is the only thing keeping it private).
 * Mapping to a closed enum prevents accidentally leaking spawn paths,
 * account ids, or token fragments through an open admin endpoint.
 *
 * Patterns are derived from real runner-side error message shapes
 * (`{claude,codex,gemini}-streaming.mjs`, `supervisor.mjs`,
 * `transport/cli.mjs`). Adding a new code requires also updating the
 * `LastErrorCode` union in `types.mjs`, which makes switch sites
 * exhaustive at typecheck time.
 *
 * Cross-realm errors (DOMException from undici, POJOs from test
 * shims) won't pass `instanceof Error` — fall back to duck-typing
 * on `typeof err.message === "string"`.
 *
 * Exported for direct unit-testing of branch coverage. Round-7 test
 * review flagged the 8+ regex branches had zero direct tests; this
 * gives them a stable target.
 *
 * @param {unknown} err
 * @returns {import("./types.mjs").LastErrorCode | null}
 */
export function classifyLastError(err) {
  if (err == null) return null;
  /** @type {string | null} */
  let msg = null;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof (/** @type {any} */ (err)?.message) === "string") {
    msg = /** @type {any} */ (err).message;
  }
  if (msg === null) return null;
  if (/ENOENT/.test(msg)) return "spawn_not_found";
  if (/EACCES|EPERM/.test(msg)) return "spawn_denied";
  if (/restart.*exceeded|exceeded.*restarts/i.test(msg)) return "restart_budget_exhausted";
  if (/auth|unauthorized|401|forbidden|403|login expired/i.test(msg)) return "auth_failed";
  // Order matters: session_init_failed before transport_closed so a
  // "session/new returned no sessionId" message doesn't match the
  // weaker transport pattern first.
  if (
    /session\/new|thread\/start|broker returned no session|returned no (session|thread) ?id/i.test(
      msg
    )
  ) {
    return "session_init_failed";
  }
  if (/timed?\s*out|ETIMEDOUT/i.test(msg)) return "timeout";
  // B1 (round-8): scope internal_error to project-specific shapes. The
  // earlier `/assert/i` substring collided with any upstream library
  // error that mentions assertions (e.g. an unrelated AssertionError
  // from a third-party SDK would mis-classify as internal_error). The
  // patterns here match only what our own code throws.
  if (/runTurn before start|invariant violation|programmer assertion/i.test(msg)) {
    return "internal_error";
  }
  // C2 (round-8): include ECONNRESET in the transport-closed bucket.
  // A supervisor that captured a raw ECONNRESET into lastError() is
  // semantically a transport close, not "unknown".
  if (/stdin unavailable|closed|EPIPE|exit code|signal|ECONNRESET/i.test(msg)) {
    return "transport_closed";
  }
  if (/out of memory|ENOMEM/i.test(msg)) return "oom";
  return "unknown";
}

/**
 * Snapshot of every currently-cached supervisor's health + last-error.
 * Returned in deterministic key order so /admin/status responses are
 * stable. Backends with no cached supervisor are omitted (they have no
 * runtime state to report — the daemon will lazily construct one on
 * first request).
 *
 * `lastError` is a redacted enum code (see `LastErrorCode`); the full
 * message stays in the daemon's stderr log for operators to grep.
 *
 * M1: each supervisor is introspected inside its own try/catch so a
 * single misbehaving entry (a Proxy getter that throws, a closed-fd
 * lazy read) cannot poison the whole snapshot. The bad entry is
 * surfaced as `health: "dead", lastError: "introspect_failed"` and
 * the other backends report normally.
 *
 * @returns {Array<{
 *   backend: BackendName,
 *   health: import("./types.mjs").StreamingHealth,
 *   lastError: import("./types.mjs").LastErrorCode | null
 * }>}
 */
export function getSupervisorStatuses() {
  /** @type {Array<{ backend: BackendName, health: import("./types.mjs").StreamingHealth, lastError: import("./types.mjs").LastErrorCode | null }>} */
  const out = [];
  for (const [backend, sup] of supervisors.entries()) {
    // M1 (round-7) + P1 (round-11 tightening): introspect health and
    // lastError in SEPARATE try blocks so a throwing lastError() doesn't
    // overwrite a successful health() reading with the synthetic "dead"
    // marker. The common pathology is both throwing together (a Proxy
    // whose getters fail), but when only one throws, operators get
    // strictly more accurate signal: health stays truthful, lastError
    // becomes "introspect_failed".
    /** @type {import("./types.mjs").StreamingHealth} */
    let health;
    try {
      health = sup.health();
    } catch {
      health = "dead";
    }
    /** @type {import("./types.mjs").LastErrorCode | null} */
    let lastErrorCode;
    try {
      const err = typeof sup.lastError === "function" ? sup.lastError() : null;
      lastErrorCode = classifyLastError(err);
    } catch {
      lastErrorCode = "introspect_failed";
    }
    out.push({
      backend: /** @type {BackendName} */ (backend),
      health,
      lastError: lastErrorCode
    });
  }
  // Deterministic order: backend name asc.
  out.sort((a, b) => (a.backend < b.backend ? -1 : a.backend > b.backend ? 1 : 0));
  return out;
}

/**
 * Close + drop every cached supervisor. Used by tests; also safe to
 * call from a process-exit handler if a host wants to reap streaming
 * runners cleanly.
 *
 * @returns {Promise<void>}
 */
export async function shutdownAllStreamingRunners() {
  /** @type {Array<[BackendName, StreamingRunner]>} */
  const entries = /** @type {any} */ (Array.from(supervisors.entries()));
  supervisors.clear();
  // M7: route close failures to stderr instead of swallowing. A half-
  // closed transport on process exit leaves zombie subprocesses;
  // surfacing the error gives operators a thread to pull on instead
  // of "the daemon just leaked pids."
  await Promise.all(
    entries.map(([backend, s]) =>
      s.close().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[streaming:${backend}] shutdown close failed: ${message}\n`);
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

/**
 * Test-only: inject a (typically stub) supervisor for a backend so
 * `getStreamingRunner` returns it. Used to exercise the F8 eviction
 * path without spawning real subprocesses.
 *
 * @internal
 * @param {BackendName} backend
 * @param {StreamingRunner | null} supervisor
 */
export function _setSupervisorForTest(backend, supervisor) {
  if (supervisor === null) {
    supervisors.delete(backend);
  } else {
    supervisors.set(backend, supervisor);
  }
}
