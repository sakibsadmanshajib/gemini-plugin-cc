/**
 * Unit tests for the streaming-aware branch of `runStatelessTurn` in
 * `lib/runners/dispatch.mjs`.
 *
 * Cases:
 *   1. useStreaming: true → registry.getStreamingRunner is consulted
 *   2. ARTAGON_STREAMING=1 in env → same
 *   3. disableStreaming: true → vetoes env opt-in
 *   4. registry returns null → falls through to direct path silently
 *   5. registry returns runner that throws → falls back to direct + warns once
 *   6. repeated streaming failures emit the warning ONLY once per process
 *   7. happy path → runner.runTurn return value is propagated
 *   8. neither flag set → registry is not consulted
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

let savedStreamEnv = "";
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

  savedStreamEnv = process.env.ARTAGON_STREAMING ?? "";
  Reflect.deleteProperty(process.env, "ARTAGON_STREAMING");
  Reflect.deleteProperty(process.env, "ARTAGON_USE_FACADE");
  Reflect.deleteProperty(process.env, "ARTAGON_DISABLE_BROKER");
  _resetBrokerWarningForTest();

  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  if (savedStreamEnv) {
    process.env.ARTAGON_STREAMING = savedStreamEnv;
  }
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

test("useStreaming: true → registry is consulted, runTurn is called", async () => {
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

test("ARTAGON_STREAMING=1 → registry is consulted", async () => {
  process.env.ARTAGON_STREAMING = "1";
  const runner = makeFakeRunner();
  vi.mocked(getStreamingRunner).mockReturnValue(/** @type {any} */ (runner));
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" });
  expect(vi.mocked(getStreamingRunner)).toHaveBeenCalledTimes(1);
  expect(runner.runTurn).toHaveBeenCalledTimes(1);
});

test("ARTAGON_STREAMING=0 → registry is NOT consulted", async () => {
  process.env.ARTAGON_STREAMING = "0";
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" });
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
});

test("disableStreaming: true vetoes env opt-in", async () => {
  process.env.ARTAGON_STREAMING = "1";
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
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

test("neither flag → registry is not consulted", async () => {
  await runStatelessTurn(BACKEND_NAMES.GEMINI, { prompt: "hi" });
  expect(vi.mocked(getStreamingRunner)).not.toHaveBeenCalled();
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
