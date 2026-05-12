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

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  _resetStreamingRegistryForTest,
  _setSupervisorForTest,
  getStreamingRunner
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
