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
  });

  test("transport-closed dialects → transport_closed", () => {
    expect(classifyLastError(new Error("transport closed unexpectedly"))).toBe("transport_closed");
    expect(classifyLastError(new Error("EPIPE writing to stdin"))).toBe("transport_closed");
    expect(classifyLastError(new Error("child exited with exit code 1"))).toBe("transport_closed");
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

  test("M1: a supervisor whose .health() throws does NOT poison the whole snapshot", () => {
    const healthy = makeStubWithError("healthy", null);
    const poisoned = /** @type {any} */ ({
      async start() {},
      async runTurn() {
        return /** @type {any} */ ({});
      },
      async close() {},
      health: () => {
        throw new Error("introspection blew up");
      },
      lastError: () => null
    });
    _setSupervisorForTest(BACKEND_NAMES.CLAUDE, healthy);
    _setSupervisorForTest(BACKEND_NAMES.CODEX, poisoned);

    const statuses = getSupervisorStatuses();
    // Both backends appear — the poisoned one doesn't take down the
    // whole list. Healthy entry reports normally; poisoned entry is
    // marked dead + introspect_failed so operators see the failure.
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

  test("empty registry → empty array (lazy construction means no boot-time entries)", () => {
    expect(getSupervisorStatuses()).toEqual([]);
  });
});
