/**
 * Unit tests for the streaming-aware branch of `runStatelessTurn` in
 * `lib/runners/dispatch.mjs`.
 *
 * Phase 4 migration: dispatch decisions are sourced from
 * `AgentContext.dispatch.streaming` (tri-state), NOT from
 * `process.env.ARTAGON_STREAMING`. Tests pass a context as the third
 * positional to `runStatelessTurn` instead of mutating env. The legacy
 * `options.useStreaming` / `options.disableStreaming` overrides remain
 * supported for callers that haven't migrated to context yet.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("#lib/runners/streaming/registry.mjs", () => ({
  getStreamingRunner: vi.fn()
}));
vi.mock("#lib/runners/claude-print.mjs", () => ({
  runClaudePrint: vi.fn()
}));
vi.mock("#lib/runners/codex-exec.mjs", () => ({
  runCodexExec: vi.fn()
}));
vi.mock("#lib/runners/gemini-print.mjs", () => ({
  runGeminiPrint: vi.fn()
}));
vi.mock("#lib/runners/gemini-broker.mjs", () => ({
  runGeminiViaBroker: vi.fn()
}));
vi.mock("#lib/transport/broker-probe.mjs", () => ({
  findActiveBroker: vi.fn()
}));

const { getStreamingRunner } = await import("#lib/runners/streaming/registry.mjs");
const { runClaudePrint } = await import("#lib/runners/claude-print.mjs");
const { runCodexExec } = await import("#lib/runners/codex-exec.mjs");
const { runGeminiPrint } = await import("#lib/runners/gemini-print.mjs");
const { findActiveBroker } = await import("#lib/transport/broker-probe.mjs");
const { BACKEND_NAMES } = await import("#lib/backends/names.mjs");
const { createAgentContext } = await import("#lib/agent-context.mjs");
const { runStatelessTurn, _resetBrokerWarningForTest } = await import("#lib/runners/dispatch.mjs");

const STUB = Object.freeze({
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

const STREAM_STUB = Object.freeze({
  ...STUB,
  text: "from-streaming"
});

/** A context with NO `ARTAGON_*` keys in env, used as a clean baseline. */
function emptyContext(overrides = {}) {
  return createAgentContext({
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    ...overrides
  });
}

/** @type {ReturnType<typeof vi.spyOn>} */
let stderrSpy;

beforeEach(() => {
  vi.mocked(getStreamingRunner).mockReset();
  vi.mocked(runClaudePrint).mockReset();
  vi.mocked(runCodexExec).mockReset();
  vi.mocked(runGeminiPrint).mockReset();
  vi.mocked(findActiveBroker).mockReset();

  vi.mocked(runClaudePrint).mockResolvedValue(STUB);
  vi.mocked(runCodexExec).mockResolvedValue(STUB);
  vi.mocked(runGeminiPrint).mockResolvedValue(STUB);
  vi.mocked(findActiveBroker).mockReturnValue(null);

  _resetBrokerWarningForTest();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeFakeRunner(turnImpl) {
  return {
    start: vi.fn(async () => {}),
    runTurn: vi.fn(turnImpl ?? (async () => STREAM_STUB)),
    close: vi.fn(async () => {}),
    health: vi.fn(() => "healthy")
  };
}

test("options.useStreaming: true → registry is consulted, runTurn is called", async () => {
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const result = await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    useStreaming: true
  });
  expect(vi.mocked(getStreamingRunner)).toHaveBeenCalledTimes(1);
  expect(runner.runTurn).toHaveBeenCalledTimes(1);
  expect(result).toEqual(STREAM_STUB);
  expect(vi.mocked(runGeminiPrint)).not.toHaveBeenCalled();
});

test("context.dispatch.streaming = 'on' → registry is consulted", async () => {
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const context = emptyContext({ dispatch: { streaming: "on" } });
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" }, context);
  expect(vi.mocked(getStreamingRunner)).toHaveBeenCalledTimes(1);
  expect(runner.runTurn).toHaveBeenCalledTimes(1);
});

test("context.dispatch.streaming = 'off' → registry is NOT consulted (even with options.useStreaming)", async () => {
  const context = emptyContext({ dispatch: { streaming: "off" } });
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi", useStreaming: true }, context);
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
});

test("context.dispatch.streaming = 'default' falls through to options/env precedence", async () => {
  const context = emptyContext({ dispatch: { streaming: "default" } });
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" }, context);
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
});

test("options.disableStreaming: true vetoes options.useStreaming", async () => {
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    useStreaming: true,
    disableStreaming: true
  });
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
});

test("registry returns null → silent fall-through to direct path", async () => {
  vi.mocked(getStreamingRunner).mockReturnValue(null);
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt: "hi",
    useStreaming: true
  });
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(1);
  // No warning when the registry CLEANLY returns null — that's just
  // "this backend has no streaming runner today", not an error.
  const warns = stderrSpy.mock.calls.filter((c) => String(c[0]).includes("[dispatch] streaming"));
  expect(warns.length).toBe(0);
});

test("runner throws → falls back to direct path with one-shot warning", async () => {
  const runner = makeFakeRunner(async () => {
    throw new Error("ECONNREFUSED");
  });
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const result = await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    useStreaming: true
  });
  expect(result).toEqual(STUB); // direct path return
  expect(runner.runTurn).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(1);
  const warns = stderrSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] streaming runner failed")
  );
  expect(warns.length).toBe(1);
});

test("repeated streaming failures emit the warning only once per process", async () => {
  const runner = makeFakeRunner(async () => {
    throw new Error("boom");
  });
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  for (let i = 0; i < 4; i++) {
    await runStatelessTurn(BACKEND_NAMES.GEMINI, {
      prompt: `hi ${i}`,
      useStreaming: true
    });
  }
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(4);
  const warns = stderrSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] streaming runner failed")
  );
  expect(warns.length).toBe(1);
});

test("happy path: runner.runTurn return value is propagated", async () => {
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const result = await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    useStreaming: true
  });
  expect(result.text).toBe("from-streaming");
});

test("neither flag/context → registry is not consulted", async () => {
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" });
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
});

test("F2: --session id WITHOUT streaming → boundary throws with actionable message", async () => {
  const ctx = createAgentContext({
    dispatch: { streaming: "off", facade: "default", broker: "auto" },
    session: { action: "resume", id: "abc-123" }
  });
  await expect(runStatelessTurn(BACKEND_NAMES.CODEX, { prompt: "hi" }, ctx)).rejects.toThrow(
    /--session.*--new-session.*requires streaming/
  );
});

test("F2: --new-session WITHOUT streaming → boundary throws with actionable message", async () => {
  const ctx = createAgentContext({
    dispatch: { streaming: "off", facade: "default", broker: "auto" },
    session: { action: "fresh" }
  });
  await expect(runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" }, ctx)).rejects.toThrow(
    /--session.*--new-session.*requires streaming/
  );
});

test("F2: session policy + streaming=on does NOT throw at boundary", async () => {
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const ctx = createAgentContext({
    dispatch: { streaming: "on", facade: "default", broker: "auto" },
    session: { action: "fresh" }
  });
  await expect(runStatelessTurn(BACKEND_NAMES.CODEX, { prompt: "hi" }, ctx)).resolves.toBeDefined();
});

test("F2: no session policy + streaming=off → boundary does NOT throw (normal cold-start)", async () => {
  vi.mocked(runCodexExec).mockResolvedValue(/** @type {any} */ (STUB));
  const ctx = createAgentContext({
    dispatch: { streaming: "off", facade: "default", broker: "auto" }
  });
  await expect(runStatelessTurn(BACKEND_NAMES.CODEX, { prompt: "hi" }, ctx)).resolves.toBeDefined();
});

test("forwards prompt + cwd + model + onUpdate to runTurn", async () => {
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  const onUpdate = () => {};
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "explain",
    cwd: "/tmp/ws",
    model: "gemini-2.5-pro",
    onUpdate,
    useStreaming: true
  });
  const callArgs = runner.runTurn.mock.calls[0][0];
  expect(callArgs.prompt).toBe("explain");
  expect(callArgs.cwd).toBe("/tmp/ws");
  expect(callArgs.model).toBe("gemini-2.5-pro");
  expect(callArgs.onUpdate).toBe(onUpdate);
});
