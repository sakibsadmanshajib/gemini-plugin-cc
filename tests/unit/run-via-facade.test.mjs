/**
 * Unit tests for `lib/runners/facade-dispatch.mjs::runViaFacade`.
 *
 * Strategy: mock `readManifest` (so the test doesn't need a real
 * facade running), then mock global `fetch` to return canned OpenAI-
 * shape responses. Verify that:
 *
 *   - missing manifest → reject with actionable message
 *   - happy path → TurnResult populated from response.choices[0]
 *   - HTTP non-2xx → reject with status text
 *   - tool_calls in response → mapped to TurnResult.toolCalls
 *   - bearerToken / ARTAGON_FACADE_API_KEY → Authorization header set
 *   - timeout → fetch's AbortSignal fires
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("#lib/server/facade-endpoint.mjs", () => ({
  readManifest: vi.fn(),
  deleteManifest: vi.fn(),
  compareAndDeleteManifest: vi.fn()
}));

const { readManifest, compareAndDeleteManifest } = await import("#lib/server/facade-endpoint.mjs");
const { runViaFacade } = await import("#lib/runners/facade-dispatch.mjs");
const { BACKEND_NAMES } = await import("#lib/backends/names.mjs");

/** @type {ReturnType<typeof vi.fn>} */
let fetchMock;
let savedFetch;
/** @type {string} */
let tmpCostHome;
let savedCostEnv;

beforeEach(() => {
  // Redirect cost.jsonl to a temp dir so this test doesn't litter the
  // real $XDG_STATE_HOME with phantom records.
  tmpCostHome = fs.mkdtempSync(path.join("/tmp", "rvf-"));
  savedCostEnv = process.env.XDG_STATE_HOME ?? "";
  process.env.XDG_STATE_HOME = tmpCostHome;

  vi.mocked(readManifest).mockReset();
  vi.mocked(readManifest).mockReturnValue({
    host: "127.0.0.1",
    port: 31337,
    pid: process.pid,
    startedAt: "2026-05-09T00:00:00.000Z",
    autoKey: null
  });
  fetchMock = vi.fn();
  savedFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (fetchMock);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedCostEnv) {
    process.env.XDG_STATE_HOME = savedCostEnv;
  } else {
    Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  }
  fs.rmSync(tmpCostHome, { recursive: true, force: true });
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

test("missing manifest → reject with actionable message", async () => {
  vi.mocked(readManifest).mockReturnValueOnce(null);
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /no running facade/
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("happy path: TurnResult populated from choices[0]", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      id: "chatcmpl-1",
      model: "claude-sonnet-4-6",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "the answer is 4" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    })
  );
  const result = await runViaFacade(BACKEND_NAMES.CLAUDE, {
    prompt: "what is 2+2?"
  });
  expect(result.text).toBe("the answer is 4");
  expect(result.reason).toBe("stop");
  expect(result.model).toBe("claude-sonnet-4-6");
  expect(result.usage.total_tokens).toBe(14);
});

test("HTTP non-2xx → reject with status text", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response("nope", { status: 500, statusText: "Internal Server Error" })
  );
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /500.*Internal Server Error/
  );
});

test("N2 (round-9): non-2xx body with model+usage → cost record captures both", async () => {
  // Real-world: a 429 from an upstream provider often returns an
  // OpenAI-shape body with `model` + `usage` (the request was billed
  // even though it failed). Previously the cost record had model:null,
  // usage:null — operator stats undercounted. Now we opportunistically
  // parse the error body.
  const errBody = JSON.stringify({
    error: { message: "rate limit", type: "rate_limit_error" },
    model: "claude-opus-4-7",
    usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 }
  });
  fetchMock.mockResolvedValueOnce(
    new Response(errBody, {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Content-Type": "application/json" }
    })
  );
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hello there" })).rejects.toThrow(
    /429/
  );

  const logPath = path.join(tmpCostHome, "artagon-agent-cli-plugin", "cost.jsonl");
  expect(fs.existsSync(logPath)).toBe(true);
  const records = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    backend: BACKEND_NAMES.CLAUDE,
    model: "claude-opus-4-7",
    ok: false,
    transport: "facade"
  });
  // The usage field is normalized by normalizeUsage; just verify the
  // prompt_tokens propagated rather than being lost as null.
  expect(records[0].usage).toBeTruthy();
  expect(records[0].usage.prompt_tokens ?? records[0].usage.input_tokens).toBe(12);
});

test("N2: non-2xx body that isn't JSON gracefully falls back to model:null/usage:null", async () => {
  // Don't crash on garbage HTML / text/plain error bodies.
  fetchMock.mockResolvedValueOnce(
    new Response("<html><body>503 Bad Gateway</body></html>", {
      status: 503,
      statusText: "Service Unavailable"
    })
  );
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(/503/);

  const logPath = path.join(tmpCostHome, "artagon-agent-cli-plugin", "cost.jsonl");
  const records = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    ok: false,
    transport: "facade",
    model: null
  });
});

test("tool_calls in response → mapped to TurnResult.toolCalls", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      id: "x",
      model: "claude",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    })
  );
  const result = await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  expect(result.toolCalls.length).toBe(1);
  expect(result.toolCalls[0].toolName).toBe("read_file");
  expect(result.toolCalls[0].toolUseId).toBe("call_1");
  expect(result.toolCalls[0].args).toEqual({ path: "a.txt" });
});

test("bearerToken option → Authorization: Bearer <token>", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  await runViaFacade(BACKEND_NAMES.CLAUDE, {
    prompt: "hi",
    bearerToken: "sk-supplied"
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0][1];
  expect(init.headers.authorization).toBe("Bearer sk-supplied");
});

test("context.facade.apiKey → Authorization: Bearer <key>", async () => {
  const { createAgentContext } = await import("#lib/agent-context.mjs");
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  const context = createAgentContext({
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    facade: { apiKey: "sk-from-context" }
  });
  await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" }, context);
  const init = fetchMock.mock.calls[0][1];
  expect(init.headers.authorization).toBe("Bearer sk-from-context");
});

test("explicit bearerToken wins over context.facade.apiKey", async () => {
  const { createAgentContext } = await import("#lib/agent-context.mjs");
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  const context = createAgentContext({
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    facade: { apiKey: "sk-context" }
  });
  await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi", bearerToken: "sk-explicit" }, context);
  const init = fetchMock.mock.calls[0][1];
  expect(init.headers.authorization).toBe("Bearer sk-explicit");
});

test("no auth → no Authorization header", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi", env: {} });
  const init = fetchMock.mock.calls[0][1];
  expect(init.headers.authorization).toBeUndefined();
});

test("model option → forwarded as request body model field", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  await runViaFacade(BACKEND_NAMES.GEMINI, {
    prompt: "hi",
    model: "gemini-2.5-pro-preview"
  });
  const init = fetchMock.mock.calls[0][1];
  const body = JSON.parse(init.body);
  expect(body.model).toBe("gemini-2.5-pro-preview");
});

test("default model derives from backend name when option omitted", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    })
  );
  await runViaFacade(BACKEND_NAMES.CODEX, { prompt: "hi" });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.model).toBe("codex");
});

test("network error → reject and emit a cost record with ok=false (round-7 TC3)", async () => {
  // Round-7 test reviewer flagged this test as a near-no-op: its title
  // promised cost-record assertions but the body only checked the
  // throw. Now reads the JSONL at $XDG_STATE_HOME and verifies one
  // record was appended with ok=false, transport=facade.
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /ECONNREFUSED/
  );

  const logPath = path.join(tmpCostHome, "artagon-agent-cli-plugin", "cost.jsonl");
  expect(fs.existsSync(logPath)).toBe(true);
  const records = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    backend: BACKEND_NAMES.CLAUDE,
    ok: false,
    transport: "facade"
  });
});

test("K2: ECONNREFUSED with err.code → compareAndDeleteManifest fires + actionable error", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({ committed: true });
  // Mimic undici's structured network error: err.cause.code === "ECONNREFUSED"
  const netErr = /** @type {any} */ (new Error("fetch failed"));
  netErr.cause = { code: "ECONNREFUSED" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted.*retry the command/
  );

  // Manifest was atomically wiped via compareAndDeleteManifest.
  expect(compareAndDeleteManifest).toHaveBeenCalledTimes(1);
  expect(compareAndDeleteManifest).toHaveBeenCalledWith(
    { pid: process.pid, port: 31337 },
    expect.anything()
  );
});

test("K2: ENOTFOUND with err.code → also wipes (same recovery path)", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({ committed: true });
  const netErr = /** @type {any} */ (new Error("dns lookup"));
  netErr.cause = { code: "ENOTFOUND" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted/
  );
  expect(compareAndDeleteManifest).toHaveBeenCalledTimes(1);
});

test("K2: non-network rejection (e.g. AbortError) does NOT call compareAndDeleteManifest", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  fetchMock.mockRejectedValueOnce(new Error("aborted"));

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(/aborted/);
  expect(compareAndDeleteManifest).not.toHaveBeenCalled();
});

test("Q5 (round-11): facade errors carry machine-readable .code", async () => {
  // Downstream catch blocks should be able to switch on err.code
  // instead of substring-matching the prose. Three classes:
  // FACADE_UNREACHABLE / FACADE_RACE_REPLACED / FACADE_CONN_RESET.
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({ committed: true });
  const netErr = /** @type {any} */ (new Error("fetch failed"));
  netErr.cause = { code: "ECONNREFUSED" };
  fetchMock.mockRejectedValueOnce(netErr);

  let caught;
  try {
    await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(/** @type {any} */ (caught).code).toBe("FACADE_UNREACHABLE");

  // ECONNRESET branch → FACADE_CONN_RESET (doesn't go through wipe path)
  const rstErr = /** @type {any} */ (new Error("socket hang up"));
  rstErr.cause = { code: "ECONNRESET" };
  fetchMock.mockRejectedValueOnce(rstErr);
  try {
    await runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" });
  } catch (err) {
    caught = err;
  }
  expect(/** @type {any} */ (caught).code).toBe("FACADE_CONN_RESET");
});

test("L1: ECONNRESET surfaces 'connection reset' error WITHOUT wiping manifest", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  const netErr = /** @type {any} */ (new Error("socket hang up"));
  netErr.cause = { code: "ECONNRESET" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /connection.*reset.*ECONNRESET/i
  );
  expect(compareAndDeleteManifest).not.toHaveBeenCalled();
});

test("M3: EHOSTUNREACH triggers the same race-safe wipe path as ECONNREFUSED", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({ committed: true });
  const netErr = /** @type {any} */ (new Error("host unreachable"));
  netErr.cause = { code: "EHOSTUNREACH" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted|EHOSTUNREACH/
  );
  expect(compareAndDeleteManifest).toHaveBeenCalledTimes(1);
});

test("M3: ENETUNREACH also wipes (same fatal-network semantic)", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({ committed: true });
  const netErr = /** @type {any} */ (new Error("network unreachable"));
  netErr.cause = { code: "ENETUNREACH" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted|ENETUNREACH/
  );
  expect(compareAndDeleteManifest).toHaveBeenCalledTimes(1);
});

test("S1 (round-13): compareAndDeleteManifest reports race → FACADE_RACE_REPLACED + reason", async () => {
  // The atomic rename + verify saw a different pid+port at the manifest
  // path than what we captured. compareAndDeleteManifest restored the
  // file (or saw it was already gone) and reported committed:false.
  // Dispatcher should NOT claim it wiped; the error string should
  // reflect the actual reason.
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({
    committed: false,
    reason: "different_manifest_restored"
  });
  const netErr = /** @type {any} */ (new Error("connection refused"));
  netErr.cause = { code: "ECONNREFUSED" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Another process has already refreshed.*different_manifest_restored/
  );
});

test("S1: 'already gone' race → same FACADE_RACE_REPLACED outcome", async () => {
  vi.mocked(compareAndDeleteManifest).mockReset();
  vi.mocked(compareAndDeleteManifest).mockReturnValue({
    committed: false,
    reason: "manifest_already_gone"
  });
  const netErr = /** @type {any} */ (new Error("connection refused"));
  netErr.cause = { code: "ECONNREFUSED" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /manifest_already_gone/
  );
});
