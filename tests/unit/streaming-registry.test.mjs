/**
 * Unit tests for the streaming runner registry's caching + eviction
 * semantics (`lib/runners/streaming/registry.mjs`).
 *
 * Coverage:
 *   - F7: cache key is `backend` only (cwd no longer in key)
 *   - F8: dead supervisors are evicted on next get; a fresh one is
 *         constructed instead of returning the permadead instance
 *   - F8: healthy / starting / degraded / restarting supervisors are
 *         NOT evicted — only "dead" is
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  _resetStreamingRegistryForTest,
  _setSupervisorForTest,
  classifyLastError,
  getStreamingRunner,
  getSupervisorStatuses
} from "#lib/runners/streaming/registry.mjs";

beforeEach(() => {
  _resetStreamingRegistryForTest();
});

afterEach(() => {
  _resetStreamingRegistryForTest();
});

/**
 * Build a stub supervisor that reports the given health.
 *
 * @param {import("#lib/runners/streaming/types.mjs").StreamingHealth} h
 */
function makeStub(h) {
  const closeSpy = vi.fn(async () => {});
  return {
    async start() {},
    async runTurn() {
      return /** @type {any} */ ({});
    },
    close: closeSpy,
    health: () => h,
    _closeSpy: closeSpy
  };
}

test("F8: dead supervisor is evicted on next getStreamingRunner call", async () => {
  const dead = makeStub("dead");
  _setSupervisorForTest(BACKEND_NAMES.CODEX, /** @type {any} */ (dead));
  // First fetch: cached dead supervisor is detected and evicted; a
  // fresh real supervisor is constructed in its place.
  const fresh = getStreamingRunner(BACKEND_NAMES.CODEX, { cwd: "/tmp" });
  expect(fresh).not.toBe(dead);
  expect(fresh).not.toBeNull();
  // The dead instance gets a best-effort close() call.
  // (microtask hop because eviction's close is fire-and-forget)
  await Promise.resolve();
  expect(dead._closeSpy).toHaveBeenCalled();
});

test("F8: healthy supervisor is NOT evicted; same instance returned", () => {
  const healthy = makeStub("healthy");
  _setSupervisorForTest(BACKEND_NAMES.CODEX, /** @type {any} */ (healthy));
  const got = getStreamingRunner(BACKEND_NAMES.CODEX, { cwd: "/tmp" });
  expect(got).toBe(healthy);
  expect(healthy._closeSpy).not.toHaveBeenCalled();
});

test("F8: starting supervisor is NOT evicted (pre-first-turn lazy state)", () => {
  const starting = makeStub("starting");
  _setSupervisorForTest(BACKEND_NAMES.GEMINI, /** @type {any} */ (starting));
  const got = getStreamingRunner(BACKEND_NAMES.GEMINI, { cwd: "/tmp" });
  expect(got).toBe(starting);
});

test("F8: degraded supervisor is NOT evicted — transient errors don't permadeath the daemon", () => {
  const degraded = makeStub("degraded");
  _setSupervisorForTest(BACKEND_NAMES.CLAUDE, /** @type {any} */ (degraded));
  const got = getStreamingRunner(BACKEND_NAMES.CLAUDE, { cwd: "/tmp" });
  expect(got).toBe(degraded);
});

test("F7: cache key is backend only — two calls with different cwds return SAME supervisor", () => {
  const stub = makeStub("healthy");
  _setSupervisorForTest(BACKEND_NAMES.CODEX, /** @type {any} */ (stub));
  const a = getStreamingRunner(BACKEND_NAMES.CODEX, { cwd: "/tmp/repo-a" });
  const b = getStreamingRunner(BACKEND_NAMES.CODEX, { cwd: "/tmp/repo-b" });
  expect(a).toBe(b);
  expect(a).toBe(stub);
});

test("F8 + F7: after eviction, fresh supervisor handles a different cwd cleanly", () => {
  const dead = makeStub("dead");
  _setSupervisorForTest(BACKEND_NAMES.CODEX, /** @type {any} */ (dead));
  const first = getStreamingRunner(BACKEND_NAMES.CODEX, {
    cwd: "/tmp/repo-a"
  });
  expect(first).not.toBe(dead);
  expect(first).not.toBeNull();
  // Subsequent call with a different cwd reuses the freshly-created
  // supervisor (cache key is now backend only).
  const second = getStreamingRunner(BACKEND_NAMES.CODEX, {
    cwd: "/tmp/repo-b"
  });
  expect(second).toBe(first);
});

/**
 * Stub supervisor with a typed lastError() function.
 *
 * @param {import("#lib/runners/streaming/types.mjs").StreamingHealth} h
 * @param {Error | null} err
 */
function makeStubWithError(h, err) {
  return /** @type {any} */ ({
    async start() {},
    async runTurn() {
      return /** @type {any} */ ({});
    },
    async close() {},
    health: () => h,
    lastError: () => err
  });
}

describe("classifyLastError — L3 redaction enum (round-7 TC1)", () => {
  // Each test drives a canonical error message that the runners
  // actually produce, then asserts the classifier maps it to the
  // intended LastErrorCode. Regression-guards the L3 redaction
  // contract — a refactor that returns raw err.message would fail
  // these tests because the test inputs include path fragments.
  test("ENOENT → spawn_not_found", () => {
    expect(classifyLastError(new Error("spawn codex ENOENT"))).toBe("spawn_not_found");
  });

  test("EACCES / EPERM → spawn_denied", () => {
    expect(classifyLastError(new Error("spawn /usr/local/bin/claude EACCES"))).toBe("spawn_denied");
    expect(classifyLastError(new Error("EPERM: operation not permitted"))).toBe("spawn_denied");
  });

  test("restart-budget exceeded → restart_budget_exhausted", () => {
    expect(
      classifyLastError(new Error("supervisor: exceeded 3 restarts in 60000ms — declaring dead"))
    ).toBe("restart_budget_exhausted");
  });

  test("auth-shape messages → auth_failed", () => {
    expect(classifyLastError(new Error("401 Unauthorized from anthropic"))).toBe("auth_failed");
    expect(classifyLastError(new Error("claude login expired"))).toBe("auth_failed");
    expect(classifyLastError(new Error("403 forbidden"))).toBe("auth_failed");
  });

  test("session/new returned no sessionId → session_init_failed", () => {
    expect(classifyLastError(new Error("session/new returned no sessionId"))).toBe(
      "session_init_failed"
    );
    expect(classifyLastError(new Error("thread/start returned no thread id"))).toBe(
      "session_init_failed"
    );
    expect(classifyLastError(new Error("broker returned no sessionId in init"))).toBe(
      "session_init_failed"
    );
  });

  test("ETIMEDOUT / timed out → timeout", () => {
    expect(classifyLastError(new Error("ETIMEDOUT"))).toBe("timeout");
    expect(classifyLastError(new Error("operation timed out after 30s"))).toBe("timeout");
  });

  test("internal-error programmer assertions → internal_error", () => {
    expect(classifyLastError(new Error("runTurn before start"))).toBe("internal_error");
    expect(classifyLastError(new Error("invariant violation"))).toBe("internal_error");
    expect(classifyLastError(new Error("programmer assertion failed"))).toBe("internal_error");
  });

  test("B1 (round-8): unrelated AssertionError from upstream SDK does NOT mis-classify as internal_error", () => {
    // Pre-B1 the bare /assert/i pattern would catch this. Now scoped
    // to project-specific shapes; a third-party AssertionError lands
    // in "unknown" instead of taking the internal_error bucket.
    expect(
      classifyLastError(new Error("AssertionError: expected 200 to be 201 (anthropic-sdk)"))
    ).toBe("unknown");
  });

  test("transport-closed dialects → transport_closed", () => {
    expect(classifyLastError(new Error("transport closed unexpectedly"))).toBe("transport_closed");
    expect(classifyLastError(new Error("EPIPE writing to stdin"))).toBe("transport_closed");
    expect(classifyLastError(new Error("child exited with exit code 1"))).toBe("transport_closed");
    // C2 (round-8): raw ECONNRESET → transport_closed (not 'unknown').
    expect(classifyLastError(new Error("connection ECONNRESET"))).toBe("transport_closed");
    expect(classifyLastError(new Error("stdin unavailable"))).toBe("transport_closed");
  });

  test("OOM dialects → oom", () => {
    expect(classifyLastError(new Error("ENOMEM"))).toBe("oom");
    expect(classifyLastError(new Error("out of memory"))).toBe("oom");
  });

  test("unmatched message → unknown (explicit bucket, never null)", () => {
    expect(classifyLastError(new Error("???"))).toBe("unknown");
  });

  test("null / undefined → null (no error to classify)", () => {
    expect(classifyLastError(null)).toBeNull();
    expect(classifyLastError(undefined)).toBeNull();
  });

  test("cross-realm error (POJO with .message) → still classified (M4 duck-typing)", () => {
    // DOMException-style errors from undici sometimes don't pass
    // `instanceof Error` across realms. Duck-type on `.message`.
    const pojo = { name: "AbortError", message: "spawn ENOENT" };
    expect(classifyLastError(pojo)).toBe("spawn_not_found");
  });

  test("redaction: raw filesystem path is NOT echoed back", () => {
    // The whole point of the L3 redaction.
    const code = classifyLastError(new Error("spawn /home/secret-user/.bin/codex ENOENT"));
    expect(code).toBe("spawn_not_found");
    expect(code).not.toContain("/home/secret-user");
  });
});

describe("getSupervisorStatuses — round-7 TC2 populated case + M1 crash safety", () => {
  test("populated supervisor surfaces redacted code; no raw message leaks", () => {
    const sup = makeStubWithError("dead", new Error("spawn /home/op/claude ENOENT"));
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, sup);

    const statuses = getSupervisorStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      backend: BACKEND_NAMES.CLAUDE,
      health: "dead",
      lastError: "spawn_not_found"
    });
    // Critical: the raw message MUST NOT appear in the response.
    expect(JSON.stringify(statuses)).not.toContain("/home/op");
  });

  test("deterministic backend ordering: claude < codex < gemini", () => {
    _setSupervisorForTest(BACKEND_NAMES.GEMINI, makeStubWithError("healthy", null));
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, makeStubWithError("healthy", null));
    _setSupervisorForTest(BACKEND_NAMES.CODEX, makeStubWithError("healthy", null));
    const statuses = getSupervisorStatuses();
    expect(statuses.map((s) => s.backend)).toEqual([
      BACKEND_NAMES.CLAUDE,
      BACKEND_NAMES.CODEX,
      BACKEND_NAMES.GEMINI
    ]);
  });

  test("M1: a supervisor whose .health() AND .lastError() both throw → dead + introspect_failed", () => {
    const healthy = makeStubWithError("healthy", null);
    const fullyPoisoned = /** @type {any} */ ({
      async start() {},
      async runTurn() {
        return /** @type {any} */ ({});
      },
      async close() {},
      health: () => {
        throw new Error("introspection blew up");
      },
      lastError: () => {
        throw new Error("lastError also blew up");
      }
    });
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, healthy);
    _setSupervisorForTest(BACKEND_NAMES.CODEX, fullyPoisoned);

    const statuses = getSupervisorStatuses();
    expect(statuses).toHaveLength(2);
    const byBackend = Object.fromEntries(statuses.map((s) => [s.backend, s]));
    expect(byBackend[BACKEND_NAMES.CLAUDE]).toEqual({
      backend: BACKEND_NAMES.CLAUDE,
      health: "healthy",
      lastError: null
    });
    expect(byBackend[BACKEND_NAMES.CODEX]).toEqual({
      backend: BACKEND_NAMES.CODEX,
      health: "dead",
      lastError: "introspect_failed"
    });
  });

  test("P1 (round-11): only .health() throws → dead + truthful lastError (separated try-blocks)", () => {
    // Round-8 reviewer C3: tighter try/catch scoping means a successful
    // lastError() doesn't get overwritten by the synthetic introspect_failed
    // marker just because health() threw. Operators get strictly more
    // accurate signal — the supervisor reports "dead, but the actual
    // error we last captured was X".
    const partial = /** @type {any} */ ({
      async start() {},
      async runTurn() {
        return /** @type {any} */ ({});
      },
      async close() {},
      health: () => {
        throw new Error("health getter broke");
      },
      // lastError() succeeds and returns a known error → classifier
      // produces "spawn_not_found", NOT "introspect_failed".
      lastError: () => new Error("spawn ENOENT")
    });
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, partial);

    const [status] = getSupervisorStatuses();
    expect(status.health).toBe("dead");
    expect(status.lastError).toBe("spawn_not_found");
  });

  test("P1: only .lastError() throws → health stays truthful + lastError becomes introspect_failed", () => {
    const partial = /** @type {any} */ ({
      async start() {},
      async runTurn() {
        return /** @type {any} */ ({});
      },
      async close() {},
      health: () => "healthy",
      lastError: () => {
        throw new Error("lastError getter broke");
      }
    });
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, partial);

    const [status] = getSupervisorStatuses();
    expect(status.health).toBe("healthy");
    expect(status.lastError).toBe("introspect_failed");
  });

  test("empty registry → empty array (lazy construction means no boot-time entries)", () => {
    expect(getSupervisorStatuses()).toEqual([]);
  });
});

describe("classifyLastError — real runner string coverage (round-16 lock-in)", () => {
  // Round-16 verification: every error message the streaming runners
  // ACTUALLY produce in lib/runners/streaming/* and lib/transport/cli.mjs
  // maps to a concrete LastErrorCode bucket, not the "unknown" fallback.
  // This locks the wording at BOTH ends: if a runner changes its error
  // message slightly (e.g. "returned no" → "gave back no"), the test for
  // that specific message fails and we know to update the classifier
  // regex in lockstep. Otherwise such a change would silently regress
  // the wire shape to "unknown" without any visible warning.
  //
  // Strings copied verbatim from grepped source lines:
  //   supervisor.mjs:118, 151
  //   codex-streaming.mjs:265, 278, 338, 385
  //   gemini-streaming.mjs:193, 206, 258, 304
  //   claude-streaming.mjs:231, 244, 293, 334
  //   transport/cli.mjs:148

  test("supervisor: 'runner is dead (max restarts exceeded)' → restart_budget_exhausted", () => {
    expect(classifyLastError(new Error("supervisor: runner is dead (max restarts exceeded)"))).toBe(
      "restart_budget_exhausted"
    );
  });

  test("codex: 'thread/start returned no thread id' → session_init_failed", () => {
    expect(
      classifyLastError(new Error("createCodexStreamingRunner: thread/start returned no thread id"))
    ).toBe("session_init_failed");
    expect(
      classifyLastError(new Error("codex streaming runner: thread/start returned no thread id"))
    ).toBe("session_init_failed");
  });

  test("codex: 'runTurn before start' → internal_error", () => {
    expect(classifyLastError(new Error("codex streaming runner: runTurn before start"))).toBe(
      "internal_error"
    );
  });

  test("codex: 'turn timed out after Xms' → timeout", () => {
    expect(
      classifyLastError(new Error("codex streaming runner: turn timed out after 30000ms"))
    ).toBe("timeout");
  });

  test("gemini: 'broker returned no sessionId' → session_init_failed", () => {
    expect(
      classifyLastError(new Error("createGeminiStreamingRunner: broker returned no sessionId"))
    ).toBe("session_init_failed");
  });

  test("gemini: 'session/new returned no sessionId' → session_init_failed", () => {
    expect(
      classifyLastError(new Error("gemini streaming runner: session/new returned no sessionId"))
    ).toBe("session_init_failed");
  });

  test("gemini: 'runTurn before start' → internal_error", () => {
    expect(classifyLastError(new Error("gemini streaming runner: runTurn before start"))).toBe(
      "internal_error"
    );
  });

  test("gemini: 'turn timed out after Xms' → timeout", () => {
    expect(
      classifyLastError(new Error("gemini streaming runner: turn timed out after 60000ms"))
    ).toBe("timeout");
  });

  test("claude: 'session/new returned no sessionId' → session_init_failed", () => {
    expect(
      classifyLastError(new Error("createClaudeStreamingRunner: session/new returned no sessionId"))
    ).toBe("session_init_failed");
    expect(
      classifyLastError(new Error("claude streaming runner: session/new returned no sessionId"))
    ).toBe("session_init_failed");
  });

  test("claude: 'runTurn before start' → internal_error", () => {
    expect(classifyLastError(new Error("claude streaming runner: runTurn before start"))).toBe(
      "internal_error"
    );
  });

  test("claude: 'turn timed out after Xms' → timeout", () => {
    expect(
      classifyLastError(new Error("claude streaming runner: turn timed out after 45000ms"))
    ).toBe("timeout");
  });

  test("CliTransport: 'stdin unavailable' → transport_closed", () => {
    expect(classifyLastError(new Error("CliTransport (codex): stdin unavailable"))).toBe(
      "transport_closed"
    );
  });

  test("child_process spawn: 'spawn <command> ENOENT' → spawn_not_found", () => {
    expect(classifyLastError(new Error("spawn codex ENOENT"))).toBe("spawn_not_found");
  });

  test("child_process spawn: 'spawn <command> EACCES' → spawn_denied", () => {
    expect(classifyLastError(new Error("spawn /usr/local/bin/claude EACCES"))).toBe("spawn_denied");
  });
});
