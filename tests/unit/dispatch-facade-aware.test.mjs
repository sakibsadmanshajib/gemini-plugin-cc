/**
 * Unit tests for the facade-aware dispatcher path in
 * `lib/runners/dispatch.mjs::runStatelessTurn`.
 *
 * Branches exercised:
 *   1. useFacade flag → runViaFacade is called for each backend
 *   2. ARTAGON_USE_FACADE=1 in env → same
 *   3. disableFacade: true → vetoes facade even when env says yes
 *   4. facade throws → falls back to direct (cold-start / broker) path
 *   5. repeated facade failures emit the warning ONLY once per process
 *   6. neither flag set → facade is NOT consulted (no readManifest call)
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Mock all the runners + the facade dispatch + the broker probe so we
// can assert which path the dispatcher took without spawning anything.
vi.mock("#lib/runners/facade-dispatch.mjs", () => ({
  runViaFacade: vi.fn()
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

const { runViaFacade } = await import("#lib/runners/facade-dispatch.mjs");
const { runClaudePrint } = await import("#lib/runners/claude-print.mjs");
const { runCodexExec } = await import("#lib/runners/codex-exec.mjs");
const { runGeminiPrint } = await import("#lib/runners/gemini-print.mjs");
const { runGeminiViaBroker: _ } = await import("#lib/runners/gemini-broker.mjs");
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

let savedFacadeEnv = "";
/** @type {ReturnType<typeof vi.spyOn>} */
let stderrSpy;

beforeEach(() => {
  vi.mocked(runViaFacade).mockReset();
  vi.mocked(runClaudePrint).mockReset();
  vi.mocked(runCodexExec).mockReset();
  vi.mocked(runGeminiPrint).mockReset();
  vi.mocked(findActiveBroker).mockReset();

  vi.mocked(runViaFacade).mockResolvedValue(STUB);
  vi.mocked(runClaudePrint).mockResolvedValue(STUB);
  vi.mocked(runCodexExec).mockResolvedValue(STUB);
  vi.mocked(runGeminiPrint).mockResolvedValue(STUB);
  vi.mocked(findActiveBroker).mockReturnValue(null);

  savedFacadeEnv = process.env.ARTAGON_USE_FACADE ?? "";
  Reflect.deleteProperty(process.env, "ARTAGON_USE_FACADE");
  Reflect.deleteProperty(process.env, "ARTAGON_DISABLE_BROKER");
  _resetBrokerWarningForTest();

  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  if (savedFacadeEnv) {
    process.env.ARTAGON_USE_FACADE = savedFacadeEnv;
  }
  stderrSpy.mockRestore();
});

test("useFacade: true → runViaFacade is called for CLAUDE", async () => {
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt: "hi",
    useFacade: true
  });
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runClaudePrint)).not.toHaveBeenCalled();
});

test("useFacade: true → runViaFacade is called for CODEX", async () => {
  await runStatelessTurn(BACKEND_NAMES.CODEX, {
    prompt: "hi",
    useFacade: true
  });
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCodexExec)).not.toHaveBeenCalled();
});

test("useFacade: true → runViaFacade is called for GEMINI (skips broker probe)", async () => {
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    useFacade: true
  });
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(findActiveBroker)).not.toHaveBeenCalled();
  expect(vi.mocked(runGeminiPrint)).not.toHaveBeenCalled();
});

test("ARTAGON_USE_FACADE=1 → runViaFacade is called", async () => {
  process.env.ARTAGON_USE_FACADE = "1";
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
});

test("ARTAGON_USE_FACADE=0 → runViaFacade is NOT called", async () => {
  process.env.ARTAGON_USE_FACADE = "0";
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  expect(vi.mocked(runViaFacade)).not.toHaveBeenCalled();
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(1);
});

test("disableFacade: true vetoes the env opt-in", async () => {
  process.env.ARTAGON_USE_FACADE = "1";
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt: "hi",
    disableFacade: true
  });
  expect(vi.mocked(runViaFacade)).not.toHaveBeenCalled();
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(1);
});

test("facade throws → falls back to direct path with one-shot warning", async () => {
  vi.mocked(runViaFacade).mockRejectedValueOnce(new Error("ECONNREFUSED"));
  const result = await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt: "hi",
    useFacade: true
  });
  expect(result).toEqual(STUB);
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(1);
  const warns = stderrSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] facade call failed")
  );
  expect(warns.length).toBe(1);
});

test("repeated facade failures emit the warning ONLY once per process", async () => {
  vi.mocked(runViaFacade).mockRejectedValue(new Error("ECONNREFUSED"));
  for (let i = 0; i < 4; i++) {
    await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
      prompt: `hi ${i}`,
      useFacade: true
    });
  }
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(4);
  const warns = stderrSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] facade call failed")
  );
  expect(warns.length).toBe(1);
});

test("neither flag set → facade path is not consulted", async () => {
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  expect(vi.mocked(runViaFacade)).not.toHaveBeenCalled();
  expect(vi.mocked(runClaudePrint)).toHaveBeenCalledTimes(1);
});

test("facade forwards prompt + cwd + model + bearerToken", async () => {
  await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
    prompt: "explain",
    cwd: "/tmp/ws",
    model: "claude-sonnet-4-6",
    bearerToken: "sk-test",
    useFacade: true
  });
  expect(vi.mocked(runViaFacade)).toHaveBeenCalledTimes(1);
  const [backend, opts] = vi.mocked(runViaFacade).mock.calls[0];
  expect(backend).toBe(BACKEND_NAMES.CLAUDE);
  expect(opts.prompt).toBe("explain");
  expect(opts.cwd).toBe("/tmp/ws");
  expect(opts.model).toBe("claude-sonnet-4-6");
  expect(opts.bearerToken).toBe("sk-test");
});
