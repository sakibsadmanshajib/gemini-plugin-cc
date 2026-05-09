/**
 * Unit tests for `lib/runners/streaming/supervisor.mjs::createSupervisor`.
 *
 * The supervisor wraps any StreamingRunner with lazy start, idle reaping,
 * and bounded restart. These tests use a tiny FakeRunner that lets us
 * drive every transition deterministically without spawning processes.
 *
 * Cases:
 *   - Lazy start: factory not invoked until runTurn or start
 *   - start() is idempotent (second call is a no-op)
 *   - close() is idempotent
 *   - close() during start in-flight does not crash
 *   - runTurn errors with a degraded child propagate but don't restart
 *   - runTurn errors with a dead child trigger restart up to budget
 *   - exceeding the restart budget marks the supervisor dead
 *   - dead supervisor rejects subsequent runTurn calls
 *   - idle timer reaps the runner after `idleMs`
 *   - idle timer is reset on each successful runTurn
 *   - onWarning fires on close failures and dead-budget transitions
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createSupervisor } from "#lib/runners/streaming/supervisor.mjs";

/**
 * @typedef {{
 *   started: number,
 *   closed: number,
 *   turnInvocations: number,
 *   nextTurnError: Error | null,
 *   nextTurnHealth: import("#lib/runners/streaming/types.mjs").StreamingHealth | null,
 *   startError: Error | null,
 *   closeError: Error | null
 * }} FakeState
 */

/**
 * Build a fake runner whose behavior is driven by `state`. Each call to
 * runTurn either resolves with a stub result or rejects with the queued
 * error, reporting the queued health afterwards.
 *
 * @param {FakeState} state
 */
function makeFakeRunner(state) {
  /** @type {import("#lib/runners/streaming/types.mjs").StreamingHealth} */
  let health = "starting";
  return {
    async start() {
      state.started += 1;
      if (state.startError) throw state.startError;
      health = "healthy";
    },
    async runTurn() {
      state.turnInvocations += 1;
      if (state.nextTurnError) {
        const err = state.nextTurnError;
        state.nextTurnError = null;
        if (state.nextTurnHealth) health = state.nextTurnHealth;
        state.nextTurnHealth = null;
        throw err;
      }
      health = "healthy";
      return /** @type {any} */ ({
        text: "ok",
        thoughtText: "",
        chunkCount: 1,
        chunkChars: 2,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: "stop",
        model: null,
        updates: []
      });
    },
    async close() {
      state.closed += 1;
      if (state.closeError) throw state.closeError;
      health = "dead";
    },
    health() {
      return health;
    }
  };
}

/** @type {FakeState} */
let state;
/** @type {() => any} */
let factory;

beforeEach(() => {
  state = {
    started: 0,
    closed: 0,
    turnInvocations: 0,
    nextTurnError: null,
    nextTurnHealth: null,
    startError: null,
    closeError: null
  };
  factory = vi.fn(() => makeFakeRunner(state));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("lazy start: factory not invoked until first runTurn", async () => {
  createSupervisor({ factory });
  expect(factory).not.toHaveBeenCalled();
  expect(state.started).toBe(0);
});

test("start() invokes the factory once and is idempotent", async () => {
  const sup = createSupervisor({ factory });
  await sup.start();
  await sup.start();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(state.started).toBe(1);
});

test("first runTurn() lazily starts the runner", async () => {
  const sup = createSupervisor({ factory });
  const result = await sup.runTurn({ prompt: "hi" });
  expect(state.started).toBe(1);
  expect(state.turnInvocations).toBe(1);
  expect(result.text).toBe("ok");
});

test("subsequent runTurn() reuses the same runner instance", async () => {
  const sup = createSupervisor({ factory });
  await sup.runTurn({ prompt: "1" });
  await sup.runTurn({ prompt: "2" });
  await sup.runTurn({ prompt: "3" });
  expect(state.started).toBe(1);
  expect(state.turnInvocations).toBe(3);
});

test("close() is idempotent and decrements no counters", async () => {
  const sup = createSupervisor({ factory });
  await sup.runTurn({ prompt: "hi" });
  await sup.close();
  await sup.close();
  expect(state.closed).toBe(1);
});

test("close() before start is a no-op", async () => {
  const sup = createSupervisor({ factory });
  await sup.close();
  expect(state.closed).toBe(0);
  expect(factory).not.toHaveBeenCalled();
});

test("close() rejection: onWarning fires but close completes", async () => {
  state.closeError = new Error("EBUSY");
  const onWarning = vi.fn();
  const sup = createSupervisor({ factory, onWarning });
  await sup.runTurn({ prompt: "hi" });
  await sup.close();
  expect(onWarning).toHaveBeenCalled();
  expect(onWarning.mock.calls[0][0]).toMatch(/EBUSY/);
});

test("runTurn error with degraded child does NOT trigger restart", async () => {
  const sup = createSupervisor({ factory });
  await sup.runTurn({ prompt: "warm" });
  // Error but child reports degraded (transport still open).
  state.nextTurnError = new Error("transient");
  state.nextTurnHealth = "degraded";
  await expect(sup.runTurn({ prompt: "x" })).rejects.toThrow(/transient/);
  expect(state.closed).toBe(0);
  expect(/** @type {any} */ (sup)._restartCount()).toBe(0);
  // Next turn should reuse same instance, no new factory invocation.
  await sup.runTurn({ prompt: "again" });
  expect(state.started).toBe(1);
});

test("runTurn error with dead child triggers restart (within budget)", async () => {
  const sup = createSupervisor({
    factory,
    maxRestarts: 3,
    restartWindowMs: 60_000
  });
  await sup.runTurn({ prompt: "warm" });
  state.nextTurnError = new Error("ECONNRESET");
  state.nextTurnHealth = "dead";
  await expect(sup.runTurn({ prompt: "x" })).rejects.toThrow(/ECONNRESET/);
  expect(state.closed).toBe(1);
  expect(/** @type {any} */ (sup)._restartCount()).toBe(1);
  // Next turn restarts the runner.
  await sup.runTurn({ prompt: "after" });
  expect(state.started).toBe(2);
});

test("exceeding restart budget marks supervisor dead", async () => {
  const onWarning = vi.fn();
  const sup = createSupervisor({
    factory,
    maxRestarts: 2,
    restartWindowMs: 60_000,
    onWarning
  });
  await sup.runTurn({ prompt: "warm" });

  for (let i = 0; i < 3; i++) {
    state.nextTurnError = new Error(`crash ${i}`);
    state.nextTurnHealth = "dead";
    await expect(sup.runTurn({ prompt: `try-${i}` })).rejects.toThrow(`crash ${i}`);
  }
  expect(sup.health()).toBe("dead");
  expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/declaring dead/));
});

test("dead supervisor rejects subsequent runTurn calls", async () => {
  const sup = createSupervisor({
    factory,
    maxRestarts: 1,
    restartWindowMs: 60_000
  });
  await sup.runTurn({ prompt: "warm" });
  state.nextTurnError = new Error("boom1");
  state.nextTurnHealth = "dead";
  await expect(sup.runTurn({ prompt: "1" })).rejects.toThrow("boom1");
  state.nextTurnError = new Error("boom2");
  state.nextTurnHealth = "dead";
  await expect(sup.runTurn({ prompt: "2" })).rejects.toThrow("boom2");
  // Now over budget. Next call rejects with dead message.
  await expect(sup.runTurn({ prompt: "3" })).rejects.toThrow(/dead/);
});

test("idle timer reaps the runner after idleMs of no activity", async () => {
  const sup = createSupervisor({ factory, idleMs: 10_000 });
  await sup.runTurn({ prompt: "hi" });
  expect(state.closed).toBe(0);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(state.closed).toBe(1);
  // Next turn re-creates the runner.
  await sup.runTurn({ prompt: "next" });
  expect(state.started).toBe(2);
});

test("idle timer is reset on each successful runTurn", async () => {
  const sup = createSupervisor({ factory, idleMs: 10_000 });
  await sup.runTurn({ prompt: "1" });
  await vi.advanceTimersByTimeAsync(7_000);
  expect(state.closed).toBe(0);
  await sup.runTurn({ prompt: "2" }); // resets the timer
  await vi.advanceTimersByTimeAsync(7_000);
  expect(state.closed).toBe(0); // still alive — second turn reset the clock
  await vi.advanceTimersByTimeAsync(4_000); // 11s after the 2nd turn
  expect(state.closed).toBe(1);
});

test("idleMs <= 0 disables idle reaping entirely", async () => {
  const sup = createSupervisor({ factory, idleMs: 0 });
  await sup.runTurn({ prompt: "hi" });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(state.closed).toBe(0);
});

test("health() reports starting before first turn, then defers to runner", async () => {
  const sup = createSupervisor({ factory });
  expect(sup.health()).toBe("starting");
  await sup.runTurn({ prompt: "hi" });
  expect(sup.health()).toBe("healthy");
});

test("createSupervisor rejects missing factory", () => {
  // @ts-expect-error intentional: we are testing the runtime guard
  expect(() => createSupervisor({})).toThrow(/factory/);
});
