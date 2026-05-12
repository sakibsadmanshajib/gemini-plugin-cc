/**
 * Unit tests for `lib/runners/dispatch.mjs::runStatelessTurn`.
 *
 * Step 5 of the unified-facade plan removed the cold-start runners and
 * the broker-fallback machinery. `runStatelessTurn` now has just two
 * paths:
 *   - `context.dispatch.facade === "on"` → facade (HTTP client)
 *   - otherwise                          → streaming runner
 *
 * Coverage:
 *   - default path → streaming runner
 *   - facade=on    → runViaFacade
 *   - unknown backend → throws (no cold-start fallback)
 *   - F2 boundary guard: session policy still works when streaming OR
 *     facade is enabled (no separate "facade=off + streaming=off"
 *     unreachable path post-Step 5).
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("#lib/runners/streaming/registry.mjs", () => ({
  getStreamingRunner: vi.fn()
}));
vi.mock("#lib/runners/facade-dispatch.mjs", () => ({
  runViaFacade: vi.fn()
}));

const { getStreamingRunner } = await import("#lib/runners/streaming/registry.mjs");
const { runViaFacade } = await import("#lib/runners/facade-dispatch.mjs");
const { BACKEND_NAMES } = await import("#lib/backends/names.mjs");
const { createAgentContext } = await import("#lib/agent-context.mjs");
const { runStatelessTurn } = await import("#lib/runners/dispatch.mjs");

const STUB = Object.freeze({
  text: "ok",
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

function emptyContext(overrides = {}) {
  return createAgentContext({
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    ...overrides
  });
}

beforeEach(() => {
  vi.mocked(getStreamingRunner).mockReset();
  vi.mocked(runViaFacade).mockReset();
  vi.mocked(getStreamingRunner).mockReturnValue(
    /** @type {any} */ ({
      runTurn: vi.fn().mockResolvedValue(STUB)
    })
  );
  vi.mocked(runViaFacade).mockResolvedValue(/** @type {any} */ (STUB));
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("default context → streaming runner is used", async () => {
  const ctx = emptyContext();
  await runStatelessTurn(BACKEND_NAMES.CODEX, { prompt: "hi" }, ctx);
  expect(getStreamingRunner).toHaveBeenCalled();
  expect(runViaFacade).not.toHaveBeenCalled();
});

test("context.dispatch.facade='on' + apiKey → facade dispatch", async () => {
  const ctx = emptyContext({
    dispatch: { facade: "on" },
    facade: { apiKey: "tok" }
  });
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "hi" }, ctx);
  expect(runViaFacade).toHaveBeenCalled();
  expect(getStreamingRunner).not.toHaveBeenCalled();
});

test("facade path forwards prompt + bearer + cwd to runViaFacade", async () => {
  const ctx = emptyContext({
    cwd: "/tmp/repo",
    dispatch: { facade: "on" },
    facade: { apiKey: "tok-123" }
  });
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hello" }, ctx);
  const callArgs = vi.mocked(runViaFacade).mock.calls[0];
  expect(callArgs[0]).toBe(BACKEND_NAMES.GEMINI);
  expect(callArgs[1].prompt).toBe("hello");
  expect(callArgs[1].cwd).toBe("/tmp/repo");
  expect(callArgs[1].bearerToken).toBe("tok-123");
  expect(callArgs[2]).toBe(ctx);
});

test("streaming path forwards prompt + cwd + model + signal to runner.runTurn", async () => {
  const runner = { runTurn: vi.fn().mockResolvedValue(STUB) };
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const ctx = emptyContext({ cwd: "/tmp/x", model: "claude-sonnet-4-6" });
  const ac = new AbortController();
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "go", signal: ac.signal }, ctx);
  const turnOpts = runner.runTurn.mock.calls[0][0];
  expect(turnOpts.prompt).toBe("go");
  expect(turnOpts.cwd).toBe("/tmp/x");
  expect(turnOpts.model).toBe("claude-sonnet-4-6");
  expect(turnOpts.signal).toBe(ac.signal);
});

test("unknown backend → rejects with actionable message", async () => {
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (null));
  await expect(
    runStatelessTurn(/** @type {any} */ ("nonsense"), { prompt: "hi" }, emptyContext())
  ).rejects.toThrow(/unknown backend "nonsense"/);
});

test("session policy with streaming → no boundary throw", async () => {
  const ctx = emptyContext({
    session: { action: "fresh" }
  });
  await expect(runStatelessTurn(BACKEND_NAMES.CODEX, { prompt: "hi" }, ctx)).resolves.toBeDefined();
});

test("session policy with facade=on → no boundary throw", async () => {
  const ctx = emptyContext({
    session: { action: "resume", id: "sess-abc" },
    dispatch: { facade: "on" },
    facade: { apiKey: "tok" }
  });
  await expect(
    runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "hi" }, ctx)
  ).resolves.toBeDefined();
});
