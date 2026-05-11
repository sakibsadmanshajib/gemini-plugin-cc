/**
 * Integration tests for the OpenAI Chat Completions facade.
 *
 * Tests use a synthetic `dispatch` injected at facade construction —
 * no real CLI is spawned. Coverage:
 *   - Pure helpers (resolveModelToBackend, flattenMessages,
 *     turnResultToOpenAiResponse)
 *   - HTTP endpoint shapes (/health, /v1/models, /v1/chat/completions)
 *   - Error paths (stream:true rejected, unknown model, missing messages,
 *     dispatch throws → 502 with backend named)
 *   - 404 for unknown URLs
 *   - Body parsing (invalid JSON, oversized, etc.)
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  createOpenAiFacadeServer,
  flattenMessages,
  mapFinishReason,
  resolveApiKeyPolicy,
  resolveCorsPolicy,
  resolveModelToBackend,
  turnResultToOpenAiResponse
} from "#lib/server/openai-facade.mjs";

describe("resolveModelToBackend", () => {
  test("explicit <backend>:<model> wins", () => {
    expect(resolveModelToBackend("claude:opus")).toEqual({
      backend: BACKEND_NAMES.CLAUDE,
      modelOverride: "opus"
    });
    expect(resolveModelToBackend("codex:gpt-5-codex")).toEqual({
      backend: BACKEND_NAMES.CODEX,
      modelOverride: "gpt-5-codex"
    });
    expect(resolveModelToBackend("gemini:gemini-3-flash-preview")).toEqual({
      backend: BACKEND_NAMES.GEMINI,
      modelOverride: "gemini-3-flash-preview"
    });
  });

  test("explicit <backend>: with empty suffix → no model override", () => {
    expect(resolveModelToBackend("claude:")).toEqual({
      backend: BACKEND_NAMES.CLAUDE,
      modelOverride: undefined
    });
  });

  test("claude family heuristics", () => {
    expect(resolveModelToBackend("claude")?.backend).toBe(BACKEND_NAMES.CLAUDE);
    expect(resolveModelToBackend("claude-sonnet-4-6")?.backend).toBe(BACKEND_NAMES.CLAUDE);
    expect(resolveModelToBackend("sonnet")?.backend).toBe(BACKEND_NAMES.CLAUDE);
    expect(resolveModelToBackend("opus")?.backend).toBe(BACKEND_NAMES.CLAUDE);
    expect(resolveModelToBackend("haiku")?.backend).toBe(BACKEND_NAMES.CLAUDE);
  });

  test("codex family heuristics", () => {
    expect(resolveModelToBackend("codex")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("gpt-5")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("gpt-5-codex")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("o3")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("o3-mini")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("o4-mini")?.backend).toBe(BACKEND_NAMES.CODEX);
    expect(resolveModelToBackend("spark")?.backend).toBe(BACKEND_NAMES.CODEX);
  });

  test("gemini family heuristics", () => {
    expect(resolveModelToBackend("gemini")?.backend).toBe(BACKEND_NAMES.GEMINI);
    expect(resolveModelToBackend("gemini-3-flash-preview")?.backend).toBe(BACKEND_NAMES.GEMINI);
    expect(resolveModelToBackend("auto-gemini-3")?.backend).toBe(BACKEND_NAMES.GEMINI);
  });

  test("unknown model returns null", () => {
    expect(resolveModelToBackend("bedrock-titan")).toBeNull();
    expect(resolveModelToBackend("")).toBeNull();
    expect(resolveModelToBackend(/** @type {any} */ (null))).toBeNull();
  });

  test("explicit prefix overrides heuristic", () => {
    // Even if the suffix looks like a different backend's model, the
    // explicit prefix wins.
    expect(resolveModelToBackend("gemini:claude-sonnet-4-6")).toEqual({
      backend: BACKEND_NAMES.GEMINI,
      modelOverride: "claude-sonnet-4-6"
    });
  });
});

describe("mapFinishReason", () => {
  test("Claude/Codex/OpenAI 'stop'-equivalents → 'stop'", () => {
    // The default branch — anything not explicitly mapped lands here.
    expect(mapFinishReason("end_turn")).toBe("stop"); // Claude
    expect(mapFinishReason("stop")).toBe("stop"); // Codex / OpenAI
    expect(mapFinishReason("STOP")).toBe("stop"); // Gemini (uppercase)
    expect(mapFinishReason("stop_sequence")).toBe("stop"); // Claude
    expect(mapFinishReason("anything_else")).toBe("stop");
    expect(mapFinishReason(null)).toBe("stop");
    expect(mapFinishReason(undefined)).toBe("stop");
    expect(mapFinishReason("")).toBe("stop");
  });

  test("token-limit dialects → 'length'", () => {
    expect(mapFinishReason("max_tokens")).toBe("length"); // Claude
    expect(mapFinishReason("MAX_TOKENS")).toBe("length"); // Gemini
    expect(mapFinishReason("length")).toBe("length"); // OpenAI / Codex
    expect(mapFinishReason("error_max_turns")).toBe("length"); // Claude error variant
  });

  test("safety / content-filter dialects → 'content_filter'", () => {
    expect(mapFinishReason("SAFETY")).toBe("content_filter"); // Gemini
    expect(mapFinishReason("RECITATION")).toBe("content_filter"); // Gemini
    expect(mapFinishReason("content_filter")).toBe("content_filter"); // OpenAI
  });

  test("tool-call dialects → 'tool_calls' / 'function_call'", () => {
    expect(mapFinishReason("tool_use")).toBe("tool_calls"); // Claude
    expect(mapFinishReason("tool_calls")).toBe("tool_calls"); // OpenAI
    // function_call is preserved — OpenAI distinguishes legacy
    // function_call from the newer tool_calls.
    expect(mapFinishReason("function_call")).toBe("function_call");
  });
});

describe("flattenMessages", () => {
  test("single user message", () => {
    expect(flattenMessages([{ role: "user", content: "hello" }])).toBe("User: hello");
  });

  test("system + user concatenated with role headers", () => {
    expect(
      flattenMessages([
        { role: "system", content: "Be terse." },
        { role: "user", content: "Summarize." }
      ])
    ).toBe("System: Be terse.\n\nUser: Summarize.");
  });

  test("assistant role labeled correctly", () => {
    expect(flattenMessages([{ role: "assistant", content: "ok" }])).toBe("Assistant: ok");
  });

  test("empty array returns empty string", () => {
    expect(flattenMessages([])).toBe("");
  });

  test("non-string content treated as empty", () => {
    expect(flattenMessages([{ role: "user", content: /** @type {any} */ (null) }])).toBe("User: ");
  });
});

describe("turnResultToOpenAiResponse", () => {
  /** @type {import("#lib/translate/stream-runner.mjs").TurnResult} */
  const baseTurn = {
    text: "the response",
    thoughtText: "",
    chunkCount: 1,
    chunkChars: 12,
    thoughtCount: 0,
    thoughtChars: 0,
    toolCalls: [],
    toolResults: [],
    usage: null,
    reason: null,
    updates: []
  };

  test("happy path: text in choices[0].message.content", () => {
    const r = turnResultToOpenAiResponse("claude", baseTurn);
    expect(r.object).toBe("chat.completion");
    expect(r.choices).toHaveLength(1);
    expect(r.choices[0].message).toEqual({
      role: "assistant",
      content: "the response"
    });
    expect(r.choices[0].finish_reason).toBe("stop"); // default when reason is null
    expect(r.model).toBe("claude");
  });

  test("turn.reason maps to OpenAI's canonical finish_reason set", () => {
    // Claude's "end_turn" → OpenAI's "stop". Without the mapper,
    // downstream OpenAI clients would receive a non-canonical
    // finish_reason and miss user-code branches that expect "stop".
    const r = turnResultToOpenAiResponse("codex", {
      ...baseTurn,
      reason: "end_turn"
    });
    expect(r.choices[0].finish_reason).toBe("stop");
  });

  test("Codex/Claude usage shape: input_tokens/output_tokens → prompt/completion", () => {
    const r = turnResultToOpenAiResponse("claude", {
      ...baseTurn,
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    expect(r.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    });
  });

  test("Gemini usageMetadata shape: promptTokenCount/candidatesTokenCount", () => {
    const r = turnResultToOpenAiResponse("gemini", {
      ...baseTurn,
      usage: {
        promptTokenCount: 80,
        candidatesTokenCount: 40,
        totalTokenCount: 120
      }
    });
    expect(r.usage).toEqual({
      prompt_tokens: 80,
      completion_tokens: 40,
      total_tokens: 120
    });
  });

  test("missing usage: zero tokens", () => {
    const r = turnResultToOpenAiResponse("claude", baseTurn);
    expect(r.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    });
  });
});

describe("createOpenAiFacadeServer — HTTP endpoints", () => {
  /** @type {ReturnType<typeof createOpenAiFacadeServer>} */
  let facade;
  /** @type {string} */
  let baseUrl;
  /** @type {Array<{backend: string, options: any}>} */
  let dispatchCalls;

  beforeEach(async () => {
    dispatchCalls = [];
    facade = createOpenAiFacadeServer({
      dispatch: async (backend, options) => {
        dispatchCalls.push({ backend, options });
        return {
          text: `[${backend}] response`,
          thoughtText: "",
          chunkCount: 1,
          chunkChars: 0,
          thoughtCount: 0,
          thoughtChars: 0,
          toolCalls: [],
          toolResults: [],
          usage: { input_tokens: 10, output_tokens: 5 },
          reason: "stop",
          updates: []
        };
      }
    });
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
  });

  afterEach(async () => {
    await facade.close();
  });

  test("GET /health returns 200 + ok:true", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /v1/models returns all per-backend models + aliases", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body.object).toBe("list");
    /** @type {string[]} */
    const ids = body.data.map((/** @type {any} */ d) => d.id);

    // Per-backend canonical models from each backend's modelAliases.
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("gpt-5");
    expect(ids).toContain("gpt-5-codex");
    expect(ids).toContain("spark");
    expect(ids).toContain("gemini-3.1-pro-preview");
    expect(ids).toContain("auto-gemini-3");

    // Aliases also exposed as separate ids (so clients can use either form).
    expect(ids).toContain("sonnet");
    expect(ids).toContain("opus");
    expect(ids).toContain("haiku");
    expect(ids).toContain("pro");
    expect(ids).toContain("flash");

    // Each entry has the OpenAI model shape.
    for (const m of body.data) {
      expect(m.object).toBe("model");
      expect(typeof m.id).toBe("string");
      expect(typeof m.owned_by).toBe("string");
      expect(m.owned_by).toMatch(/artagon-agent-cli-plugin \((claude|codex|gemini)\)/);
    }
  });

  test("GET /v1/models/{id}: known canonical id → 200 with single-model OpenAI shape", async () => {
    // OpenAI clients sometimes hit this to verify a model exists
    // before posting a chat completion. The facade matches against
    // the same alias set /v1/models exposes.
    const res = await fetch(`${baseUrl}/v1/models/claude-sonnet-4-6`);
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body.id).toBe("claude-sonnet-4-6");
    expect(body.object).toBe("model");
    expect(body.owned_by).toMatch(/artagon-agent-cli-plugin \(claude\)/);
  });

  test("GET /v1/models/{id}: alias also resolves (sonnet → claude)", async () => {
    const res = await fetch(`${baseUrl}/v1/models/sonnet`);
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body.id).toBe("sonnet");
    expect(body.owned_by).toMatch(/\(claude\)/);
  });

  test("GET /v1/models/{id}: unknown id → 404 with actionable error", async () => {
    const res = await fetch(`${baseUrl}/v1/models/does-not-exist`);
    expect(res.status).toBe(404);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.message).toMatch(/does-not-exist/);
    expect(body.error.message).toMatch(/\/v1\/models/);
    expect(body.error.param).toBe("id");
  });

  test("GET /v1/models/{id}: URL-encoded id is decoded before lookup", async () => {
    // Claude backend exposes "claude:opus-4-7" (explicit-backend form)
    // — the colon must round-trip via percent-encoding.
    const res = await fetch(`${baseUrl}/v1/models/${encodeURIComponent("claude:opus-4-7")}`);
    // 404 is the right shape if the id isn't in the alias set; what
    // matters here is that the error message contains the DECODED id
    // (not the raw "%3A"), confirming the decode step ran.
    if (res.status === 200) {
      const body = /** @type {any} */ (await res.json());
      expect(body.id).toBe("claude:opus-4-7");
    } else {
      expect(res.status).toBe(404);
      const body = /** @type {any} */ (await res.json());
      expect(body.error.message).toMatch(/claude:opus-4-7/);
      expect(body.error.message).not.toMatch(/%3A/);
    }
  });

  test("POST /v1/chat/completions: claude routes to claude backend", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      })
    });
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body.choices[0].message.content).toBe("[claude] response");
    expect(body.usage.prompt_tokens).toBe(10);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].backend).toBe(BACKEND_NAMES.CLAUDE);
    expect(dispatchCalls[0].options.prompt).toBe("User: hi");
  });

  test("POST /v1/chat/completions: codex via gpt-5 → codex backend", async () => {
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(dispatchCalls[0].backend).toBe(BACKEND_NAMES.CODEX);
  });

  test("POST /v1/chat/completions: gemini routes to gemini backend", async () => {
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3-pro-preview",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(dispatchCalls[0].backend).toBe(BACKEND_NAMES.GEMINI);
  });

  test("POST /v1/chat/completions stream:true → SSE chunks + [DONE]", async () => {
    // Replace the dispatch with one that fires onUpdate during the turn
    // so we can assert per-chunk streaming.
    await facade.close();
    facade = createOpenAiFacadeServer({
      dispatch: async (_backend, options) => {
        // Simulate the runner emitting two text chunks, then resolving.
        options.onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: { text: "Hello, " }
        });
        options.onUpdate?.({
          sessionUpdate: "agent_message_chunk",
          content: { text: "world." }
        });
        return {
          text: "Hello, world.",
          thoughtText: "",
          chunkCount: 2,
          chunkChars: 13,
          thoughtCount: 0,
          thoughtChars: 0,
          toolCalls: [],
          toolResults: [],
          usage: null,
          reason: "stop",
          updates: []
        };
      }
    });
    const { port, host } = await facade.listen();

    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }],
        stream: true
      })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    expect(lines.at(-1)).toBe("data: [DONE]");

    const events = lines.slice(0, -1).map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
    // First event: assistant role announce.
    expect(events[0].choices[0].delta).toEqual({ role: "assistant" });
    // Middle events: content deltas.
    expect(events[1].choices[0].delta.content).toBe("Hello, ");
    expect(events[2].choices[0].delta.content).toBe("world.");
    // Last event: finish_reason set.
    expect(events.at(-1).choices[0].finish_reason).toBe("stop");
  });

  test("POST /v1/chat/completions stream:true + stream_options.include_usage → usage chunk before [DONE]", async () => {
    // Per OpenAI's spec: when stream_options.include_usage is true,
    // the server emits an extra final chunk with `choices: []` and
    // a populated `usage` object after the final delta.
    await facade.close();
    facade = createOpenAiFacadeServer({
      dispatch: async () => ({
        text: "ok",
        thoughtText: "",
        chunkCount: 1,
        chunkChars: 2,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: { input_tokens: 42, output_tokens: 7 },
        reason: "stop",
        updates: []
      })
    });
    const { port, host } = await facade.listen();
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }],
        stream: true,
        stream_options: { include_usage: true }
      })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    expect(lines.at(-1)).toBe("data: [DONE]");

    const events = lines.slice(0, -1).map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
    // The usage chunk should be the LAST data chunk before [DONE]
    // and have empty choices + a populated usage object.
    const usageChunk = events.at(-1);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 7,
      total_tokens: 49
    });
  });

  test("POST /v1/chat/completions stream:true without include_usage → no usage chunk", async () => {
    // Default behavior: usage is NOT emitted in the stream.
    await facade.close();
    facade = createOpenAiFacadeServer({
      dispatch: async () => ({
        text: "ok",
        thoughtText: "",
        chunkCount: 1,
        chunkChars: 2,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: { input_tokens: 42, output_tokens: 7 },
        reason: "stop",
        updates: []
      })
    });
    const { port, host } = await facade.listen();
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }],
        stream: true
        // no stream_options
      })
    });
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const events = lines.slice(0, -1).map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
    // None of the events should carry a top-level `usage` field.
    for (const ev of events) {
      expect(ev.usage).toBeUndefined();
    }
  });

  test("POST /v1/chat/completions: unknown model → 400 with hint", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "bedrock-titan",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(400);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.message).toMatch(/Cannot resolve model "bedrock-titan"/);
  });

  test("POST /v1/chat/completions: n != 1 → 400 (multiple completions unsupported)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }],
        n: 3
      })
    });
    expect(res.status).toBe(400);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("n");
    expect(body.error.message).toMatch(/n != 1/);
  });

  test("POST /v1/chat/completions: n=1 (explicit) is accepted", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }],
        n: 1
      })
    });
    expect(res.status).toBe(200);
  });

  test("POST /v1/chat/completions: missing messages → 400", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude" })
    });
    expect(res.status).toBe(400);
    expect(/** @type {any} */ (await res.json()).error.message).toMatch(/messages\[\]/);
  });

  test("POST /v1/chat/completions: dispatch throws → 502 with backend named", async () => {
    await facade.close();
    facade = createOpenAiFacadeServer({
      dispatch: async () => {
        throw new Error("upstream auth required");
      }
    });
    const { port, host } = await facade.listen();
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(502);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.type).toBe("backend_error");
    expect(body.error.backend).toBe(BACKEND_NAMES.CLAUDE);
    // Public message is now redacted (CodeQL js/stack-trace-exposure
    // fix). Detail goes to server stderr; clients see only the
    // backend name + a generic prompt to check logs.
    expect(body.error.message).toMatch(/claude backend failed/);
  });

  test("GET /random — 404", async () => {
    const res = await fetch(`${baseUrl}/random`);
    expect(res.status).toBe(404);
  });

  test("invalid JSON body → 400 (client error, not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json"
    });
    expect(res.status).toBe(400);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/invalid JSON/i);
  });

  test("oversized body → 413 (request entity too large)", async () => {
    // Default cap is 1 MiB. Send 1.5 MiB to force the limit.
    const big = JSON.stringify({
      model: "claude",
      messages: [{ role: "user", content: "x".repeat(1.5 * 1024 * 1024) }]
    });
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big
    });
    expect(res.status).toBe(413);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/too large/i);
  });
});

describe("resolveCorsPolicy", () => {
  test("cors: true → wildcard", () => {
    expect(resolveCorsPolicy(true)).toBe("*");
  });

  test('cors: "*" → wildcard', () => {
    expect(resolveCorsPolicy("*")).toBe("*");
  });

  test("cors: 'http://localhost:3000' → single-element allowlist", () => {
    expect(resolveCorsPolicy("http://localhost:3000")).toEqual(["http://localhost:3000"]);
  });

  test("cors: array → allowlist", () => {
    expect(resolveCorsPolicy(["http://a.test", "http://b.test"])).toEqual([
      "http://a.test",
      "http://b.test"
    ]);
  });

  test("cors: false / empty array / undefined-with-no-env → null", () => {
    expect(resolveCorsPolicy(false, {})).toBeNull();
    expect(resolveCorsPolicy([], {})).toBeNull();
    expect(resolveCorsPolicy(undefined, {})).toBeNull();
  });

  test("String 1/true/* → wildcard (caller's bin reads env, passes the string here)", () => {
    expect(resolveCorsPolicy("1")).toBe("*");
    expect(resolveCorsPolicy("true")).toBe("*");
    expect(resolveCorsPolicy("*")).toBe("*");
  });

  test("Comma-separated string → allowlist", () => {
    expect(resolveCorsPolicy("http://a.test, http://b.test")).toEqual([
      "http://a.test",
      "http://b.test"
    ]);
  });

  test("Wildcard value wins regardless of how it was supplied", () => {
    expect(resolveCorsPolicy("*")).toBe("*");
    expect(resolveCorsPolicy(true)).toBe("*");
  });

  test("ARTAGON_FACADE_CORS env is NO LONGER read by lib (Phase 4)", () => {
    // The bin (artagon-openai-server) reads ARTAGON_FACADE_CORS and
    // passes the resulting string as the first arg here. Passing an
    // env-shape object as a "value" produces null, not "*", because
    // lib no longer consults env.
    expect(resolveCorsPolicy(undefined, { ARTAGON_FACADE_CORS: "1" })).toBeNull();
  });
});

describe("CORS — HTTP behavior", () => {
  /** @type {ReturnType<typeof createOpenAiFacadeServer>} */
  let facade;
  /** @type {string} */
  let baseUrl;

  afterEach(async () => {
    if (facade) await facade.close();
  });

  test("cors disabled by default — no Access-Control-Allow-Origin header", async () => {
    facade = createOpenAiFacadeServer({});
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://x.test" }
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("cors: '*' → echo wildcard on every response", async () => {
    facade = createOpenAiFacadeServer({ cors: "*" });
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://anywhere.test" }
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("cors: allowlist — echoes matched origin, omits unmatched", async () => {
    facade = createOpenAiFacadeServer({ cors: ["http://allowed.test"] });
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;

    const allowedRes = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://allowed.test" }
    });
    expect(allowedRes.headers.get("access-control-allow-origin")).toBe("http://allowed.test");

    const blockedRes = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://blocked.test" }
    });
    expect(blockedRes.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OPTIONS preflight → 204 with allow-headers when origin is permitted", async () => {
    facade = createOpenAiFacadeServer({ cors: "*" });
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://app.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type"
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Content-Type/i);
  });

  test("OPTIONS preflight → 405 when CORS is disabled", async () => {
    facade = createOpenAiFacadeServer({});
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { Origin: "http://anywhere.test" }
    });
    expect(res.status).toBe(405);
  });
});

describe("resolveApiKeyPolicy", () => {
  test("string → single-element allowlist", () => {
    expect(resolveApiKeyPolicy("sk-test", {})).toEqual(["sk-test"]);
  });

  test("array → allowlist (filtered for empty/non-string)", () => {
    expect(
      resolveApiKeyPolicy(/** @type {any} */ (["sk-a", "sk-b", "", null, "sk-c"]), {})
    ).toEqual(["sk-a", "sk-b", "sk-c"]);
  });

  test("undefined + no env → null (auth disabled)", () => {
    expect(resolveApiKeyPolicy(undefined, {})).toBeNull();
  });

  test("comma-separated string → allowlist (caller's bin reads env, passes the string here)", () => {
    expect(resolveApiKeyPolicy("sk-a, sk-b ,sk-c")).toEqual(["sk-a", "sk-b", "sk-c"]);
  });

  test("Single value passes through unchanged", () => {
    expect(resolveApiKeyPolicy("sk-direct")).toEqual(["sk-direct"]);
  });

  test("ARTAGON_FACADE_API_KEY env is NO LONGER read by lib (Phase 4)", () => {
    // The bin (artagon-openai-server) reads ARTAGON_FACADE_API_KEY
    // and passes the resulting string as the first arg here. The
    // env-shaped second arg is no longer consulted.
    expect(resolveApiKeyPolicy(undefined, { ARTAGON_FACADE_API_KEY: "sk-env" })).toBeNull();
  });
});

describe("API-key auth — HTTP behavior", () => {
  /** @type {ReturnType<typeof createOpenAiFacadeServer>} */
  let facade;
  /** @type {string} */
  let baseUrl;

  afterEach(async () => {
    if (facade) await facade.close();
  });

  async function startWithKey(/** @type {string | string[] | undefined} */ apiKey) {
    facade = createOpenAiFacadeServer({
      apiKey,
      dispatch: async (backend) => ({
        text: `[${backend}] response`,
        thoughtText: "",
        chunkCount: 1,
        chunkChars: 0,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: "stop",
        updates: []
      })
    });
    const { port, host } = await facade.listen();
    baseUrl = `http://${host}:${port}`;
  }

  test("disabled by default — no Authorization required", async () => {
    await startWithKey(undefined);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(200);
  });

  test("apiKey set + missing Authorization → 401 with WWW-Authenticate", async () => {
    await startWithKey("sk-correct");
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const body = /** @type {any} */ (await res.json());
    expect(body.error.code).toBe("invalid_api_key");
  });

  test("apiKey set + wrong key → 401", async () => {
    await startWithKey("sk-correct");
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-wrong"
      },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(401);
  });

  test("apiKey set + correct key → 200", async () => {
    await startWithKey("sk-correct");
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-correct"
      },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: "x" }]
      })
    });
    expect(res.status).toBe(200);
  });

  test("multi-key allowlist — any matching key passes", async () => {
    await startWithKey(["sk-a", "sk-b"]);
    for (const key of ["sk-a", "sk-b"]) {
      const res = await fetch(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` }
      });
      expect(res.status).toBe(200);
    }
    const bad = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: "Bearer sk-c" }
    });
    expect(bad.status).toBe(401);
  });

  test("/health is exempt from auth (LB probe path)", async () => {
    await startWithKey("sk-correct");
    // No Authorization header — must still pass.
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});
