/**
 * Unit tests for the broker-aware GEMINI dispatch in
 * `lib/runners/dispatch.mjs::runStatelessTurn`.
 *
 * Three branches to exercise:
 *   1. probe returns endpoint → runGeminiViaBroker is called
 *   2. probe returns null      → runGeminiPrint (cold start) is called
 *   3. probe returns endpoint but broker run throws → fallback to
 *      runGeminiPrint with one-shot stderr warning
 *
 * Plus the opt-out paths:
 *   4. options.disableBroker === true → probe is NOT called; cold-start
 *      runs unconditionally
 *   5. ARTAGON_DISABLE_BROKER=1 in env → same
 *
 * The test mocks both `lib/transport/broker-probe.mjs` and the two
 * runners to avoid spawning real CLIs and to assert call counts /
 * arguments deterministically.
 */

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Mocks must be defined BEFORE the module-under-test is imported.
// `vi.mock` hoists, but the factory references must be top-level.
vi.mock("#lib/transport/broker-probe.mjs", () => ({
  findActiveBroker: vi.fn()
}));

vi.mock("#lib/runners/gemini-print.mjs", () => ({
  runGeminiPrint: vi.fn()
}));

vi.mock("#lib/runners/gemini-broker.mjs", () => ({
  runGeminiViaBroker: vi.fn()
}));

const { findActiveBroker } = await import("#lib/transport/broker-probe.mjs");
const { runGeminiPrint } = await import("#lib/runners/gemini-print.mjs");
const { runGeminiViaBroker } = await import("#lib/runners/gemini-broker.mjs");
const { BACKEND_NAMES } = await import("#lib/backends/names.mjs");
const { runStatelessTurn, _resetBrokerWarningForTest } = await import("#lib/runners/dispatch.mjs");

const STUB_TURN_RESULT = Object.freeze({
  text: "hello",
  thoughtText: "",
  chunkCount: 1,
  chunkChars: 5,
  thoughtCount: 0,
  thoughtChars: 0,
  toolCalls: [],
  toolResults: [],
  usage: null,
  reason: "end_turn",
  model: null,
  updates: []
});

/** @type {string} */
let savedDisableBrokerEnv;
/** @type {ReturnType<typeof vi.spyOn>} */
let stderrWriteSpy;

beforeEach(() => {
  vi.mocked(findActiveBroker).mockReset();
  vi.mocked(runGeminiPrint).mockReset();
  vi.mocked(runGeminiViaBroker).mockReset();
  // Default behavior: cold-start + broker each return the canonical
  // stub turn. Tests override per-case.
  vi.mocked(runGeminiPrint).mockResolvedValue(STUB_TURN_RESULT);
  vi.mocked(runGeminiViaBroker).mockResolvedValue(STUB_TURN_RESULT);

  savedDisableBrokerEnv = process.env.ARTAGON_DISABLE_BROKER ?? "";
  Reflect.deleteProperty(process.env, "ARTAGON_DISABLE_BROKER");
  _resetBrokerWarningForTest();

  // Capture stderr.write calls so we can assert the one-shot warning
  // fires exactly once across multiple fallback dispatches.
  stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  if (savedDisableBrokerEnv) {
    process.env.ARTAGON_DISABLE_BROKER = savedDisableBrokerEnv;
  }
  stderrWriteSpy.mockRestore();
});

test("probe returns endpoint → runGeminiViaBroker is called", async () => {
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/broker.sock");
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws"
  });
  expect(vi.mocked(runGeminiViaBroker)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGeminiPrint)).not.toHaveBeenCalled();
  // Verify the endpoint flowed through.
  const call = vi.mocked(runGeminiViaBroker).mock.calls[0][0];
  expect(call.endpoint).toBe("unix:/tmp/broker.sock");
  expect(call.prompt).toBe("hi");
  expect(call.cwd).toBe("/tmp/ws");
});

test("probe returns null → runGeminiPrint (cold start) is called", async () => {
  vi.mocked(findActiveBroker).mockReturnValue(null);
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws"
  });
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGeminiViaBroker)).not.toHaveBeenCalled();
});

test("broker connect fails → falls back to cold-start with one-shot warning", async () => {
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/dead.sock");
  vi.mocked(runGeminiViaBroker).mockRejectedValueOnce(new Error("ECONNREFUSED"));
  const turn = await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws"
  });
  expect(turn).toEqual(STUB_TURN_RESULT);
  expect(vi.mocked(runGeminiViaBroker)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(1);
  // Warning fired once.
  const warns = stderrWriteSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] broker connect failed")
  );
  expect(warns.length).toBe(1);
});

test("repeated broker failures emit the warning ONLY once per process", async () => {
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/dead.sock");
  vi.mocked(runGeminiViaBroker).mockRejectedValue(new Error("ECONNREFUSED"));
  for (let i = 0; i < 3; i++) {
    await runStatelessTurn(BACKEND_NAMES.GEMINI, {
      prompt: `hi ${i}`,
      cwd: "/tmp/ws"
    });
  }
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(3);
  const warns = stderrWriteSpy.mock.calls.filter((c) =>
    String(c[0]).includes("[dispatch] broker connect failed")
  );
  expect(warns.length).toBe(1);
});

test("disableBroker: true → probe is skipped, cold-start runs", async () => {
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/broker.sock");
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws",
    disableBroker: true
  });
  expect(vi.mocked(findActiveBroker)).not.toHaveBeenCalled();
  expect(vi.mocked(runGeminiViaBroker)).not.toHaveBeenCalled();
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(1);
});

test("ARTAGON_DISABLE_BROKER=1 → probe is skipped, cold-start runs", async () => {
  process.env.ARTAGON_DISABLE_BROKER = "1";
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/broker.sock");
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws"
  });
  expect(vi.mocked(findActiveBroker)).not.toHaveBeenCalled();
  expect(vi.mocked(runGeminiViaBroker)).not.toHaveBeenCalled();
  expect(vi.mocked(runGeminiPrint)).toHaveBeenCalledTimes(1);
});

test("ARTAGON_DISABLE_BROKER=0 (or other non-1) does NOT skip probe", async () => {
  process.env.ARTAGON_DISABLE_BROKER = "0";
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/broker.sock");
  await runStatelessTurn(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    cwd: "/tmp/ws"
  });
  expect(vi.mocked(findActiveBroker)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGeminiViaBroker)).toHaveBeenCalledTimes(1);
});

// Note: CLAUDE/CODEX-bypass tests are intentionally omitted. The
// dispatcher is a hard switch over backendName; only the GEMINI branch
// imports findActiveBroker. The "claude/codex don't probe" property is
// a syntactic invariant of the switch, not a runtime check worth
// real-binary-spawn timeouts.

test("unknown backend rejects without touching broker probe", async () => {
  vi.mocked(findActiveBroker).mockReturnValue("unix:/tmp/broker.sock");
  await expect(
    runStatelessTurn(/** @type {any} */ ("nonexistent"), { prompt: "hi" })
  ).rejects.toThrow(/unknown backend/);
  expect(vi.mocked(findActiveBroker)).not.toHaveBeenCalled();
});
