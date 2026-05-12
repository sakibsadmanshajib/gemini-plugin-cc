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

test("runTurn forwards (turnOpts, context) to the wrapped runner verbatim — one supervisor, two contexts", async () => {
  // Pins the v2-plan design promise: the supervisor is cached by
  // (backend, cwd), but per-turn context flows through `runTurn`.
  // Turn 1 with context A, turn 2 with context B — the same runner
  // instance receives both contexts unchanged. Without this test the
  // whole "context-per-turn" claim is unverified.
  /** @type {Array<{ opts: any, context: any }>} */
  const captured = [];
  const capturingFactory = () => ({
    async start() {
      state.started += 1;
    },
    async runTurn(opts, context) {
      captured.push({ opts, context });
      return /** @type {any} */ ({
        text: "ok",
        thoughtText: "",
        chunkCount: 0,
        chunkChars: 0,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: null,
        model: null,
        updates: []
      });
    },
    async close() {
      state.closed += 1;
    },
    health() {
      return "healthy";
    }
  });
  const sup = createSupervisor({ factory: capturingFactory });

  const ctxA = {
    dispatch: { streaming: "on" },
    cost: { logPath: "/tmp/a.jsonl" }
  };
  const ctxB = {
    dispatch: { streaming: "on" },
    cost: { logPath: "/tmp/b.jsonl" }
  };

  await sup.runTurn({ prompt: "first" }, /** @type {any} */ (ctxA));
  await sup.runTurn({ prompt: "second" }, /** @type {any} */ (ctxB));

  expect(state.started).toBe(1); // supervisor reused — only ONE start()
  expect(captured).toHaveLength(2);
  expect(captured[0].opts.prompt).toBe("first");
  expect(captured[0].context).toBe(ctxA);
  expect(captured[1].opts.prompt).toBe("second");
  expect(captured[1].context).toBe(ctxB);
  // Same runner instance, different per-turn contexts — confirms the
  // "supervisor caches, context flows per-turn" design.
});

test("FIFO mutex: concurrent runTurn calls serialize through the wrapped runner", async () => {
  // F1 — two parallel runTurn calls must NOT race the wrapped
  // runner's single activeTurn slot. The supervisor's tail-promise
  // mutex serializes them: turn N+1 doesn't start until turn N's
  // promise has settled (resolved OR rejected).
  //
  // The suite's global beforeEach enables fake timers, so we use
  // Promise-based gates (not setImmediate) to drive turn settlement.
  vi.useRealTimers();
  /** @type {Array<{ phase: "start" | "end", id: number }>} */
  const trace = [];
  let nextId = 0;
  const runner = {
    async start() {},
    async runTurn() {
      const id = ++nextId;
      trace.push({ phase: "start", id });
      // A microtask hop is enough — Promise.all schedules each turn's
      // continuation, and the mutex's `.then(() => runTurnInner)` only
      // fires once the prior turn's tail-promise resolves.
      await Promise.resolve();
      trace.push({ phase: "end", id });
      return /** @type {any} */ ({
        text: `t${id}`,
        thoughtText: "",
        chunkCount: 0,
        chunkChars: 0,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: "stop",
        model: null,
        sessionId: null,
        updates: []
      });
    },
    async close() {},
    health() {
      return /** @type {any} */ ("healthy");
    }
  };
  const sup = createSupervisor({
    factory: () => runner,
    idleMs: 0
  });

  const [a, b, c] = await Promise.all([
    sup.runTurn({ prompt: "A" }),
    sup.runTurn({ prompt: "B" }),
    sup.runTurn({ prompt: "C" })
  ]);

  expect(a.text).toBe("t1");
  expect(b.text).toBe("t2");
  expect(c.text).toBe("t3");
  // Every start must be immediately followed by its matching end (no
  // interleaving). The exact event sequence for 3 turns is:
  //   start:1 end:1 start:2 end:2 start:3 end:3
  expect(trace).toEqual([
    { phase: "start", id: 1 },
    { phase: "end", id: 1 },
    { phase: "start", id: 2 },
    { phase: "end", id: 2 },
    { phase: "start", id: 3 },
    { phase: "end", id: 3 }
  ]);
});

test("FIFO mutex: a failed turn doesn't poison the chain — subsequent turns run", async () => {
  // Tail's `.catch(() => {})` keeps the chain alive after a rejection.
  // The failing caller still gets the rejection back; later callers
  // see a clean tail.
  vi.useRealTimers();
  const localState = { started: 0, closed: 0 };
  let i = 0;
  const runner = {
    async start() {
      localState.started += 1;
    },
    async runTurn() {
      i += 1;
      if (i === 1) throw new Error("boom");
      return /** @type {any} */ ({
        text: `t${i}`,
        thoughtText: "",
        chunkCount: 0,
        chunkChars: 0,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: "stop",
        model: null,
        sessionId: null,
        updates: []
      });
    },
    async close() {
      localState.closed += 1;
    },
    health() {
      return /** @type {any} */ ("healthy");
    }
  };
  const sup = createSupervisor({
    factory: () => runner,
    idleMs: 0
  });

  await expect(sup.runTurn({ prompt: "A" })).rejects.toThrow(/boom/);
  const result = await sup.runTurn({ prompt: "B" });
  expect(result.text).toBe("t2");
});
