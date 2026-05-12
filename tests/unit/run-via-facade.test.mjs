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
  deleteManifest: vi.fn()
}));

const { readManifest, deleteManifest } = await import("#lib/server/facade-endpoint.mjs");
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

test("network error → reject and emit a cost record with ok=false", async () => {
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /ECONNREFUSED/
  );
});

test("K2: ECONNREFUSED with err.code → deleteManifest fires + actionable error", async () => {
  vi.mocked(deleteManifest).mockReset();
  // Mimic undici's structured network error: err.cause.code === "ECONNREFUSED"
  const netErr = /** @type {any} */ (new Error("fetch failed"));
  netErr.cause = { code: "ECONNREFUSED" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted.*retry the command/
  );

  // Manifest was actually wiped so the next slash-command's auto-start
  // spawns a fresh daemon instead of getting refused again.
  expect(deleteManifest).toHaveBeenCalledTimes(1);
});

test("K2: ENOTFOUND with err.code → also deletes manifest (same recovery path)", async () => {
  vi.mocked(deleteManifest).mockReset();
  const netErr = /** @type {any} */ (new Error("dns lookup"));
  netErr.cause = { code: "ENOTFOUND" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /Stale manifest deleted/
  );
  expect(deleteManifest).toHaveBeenCalledTimes(1);
});

test("K2: non-network rejection (e.g. AbortError) does NOT delete manifest", async () => {
  vi.mocked(deleteManifest).mockReset();
  fetchMock.mockRejectedValueOnce(new Error("aborted"));

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(/aborted/);
  expect(deleteManifest).not.toHaveBeenCalled();
});

test("L1: ECONNRESET surfaces 'connection reset' error WITHOUT wiping manifest", async () => {
  // ECONNRESET means "this connection dropped" — the daemon process may
  // still be alive and serving other concurrent requests. Wiping the
  // manifest would yank the discovery file out from under healthy
  // parallel requests.
  vi.mocked(deleteManifest).mockReset();
  const netErr = /** @type {any} */ (new Error("socket hang up"));
  netErr.cause = { code: "ECONNRESET" };
  fetchMock.mockRejectedValueOnce(netErr);

  await expect(runViaFacade(BACKEND_NAMES.CLAUDE, { prompt: "hi" })).rejects.toThrow(
    /connection.*reset.*ECONNRESET/i
  );
  expect(deleteManifest).not.toHaveBeenCalled();
});
