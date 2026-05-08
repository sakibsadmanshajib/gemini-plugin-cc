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

  test("turn.reason becomes finish_reason", () => {
    const r = turnResultToOpenAiResponse("codex", {
      ...baseTurn,
      reason: "end_turn"
    });
    expect(r.choices[0].finish_reason).toBe("end_turn");
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
    expect(body.error.message).toMatch(/upstream auth required/);
  });

  test("GET /random — 404", async () => {
    const res = await fetch(`${baseUrl}/random`);
    expect(res.status).toBe(404);
  });

  test("invalid JSON body → 500", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json"
    });
    expect(res.status).toBe(500);
  });
});
