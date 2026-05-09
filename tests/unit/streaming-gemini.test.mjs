/**
 * Unit tests for `lib/runners/streaming/gemini-streaming.mjs`.
 *
 * The runner depends on three injectables (probe, createTransport,
 * createClient). All three are stubbed here so the test never opens a
 * socket or spawns a process.
 *
 * Cases:
 *   - start() with no broker → rejects, health="dead"
 *   - start() happy path → initialize + session/new are called once,
 *                         health="healthy"
 *   - runTurn before start() → rejects
 *   - runTurn() forwards prompt + sessionId to session/prompt
 *   - runTurn() accumulates session/update notifications
 *   - runTurn() reads stopReason / usage from prompt response when
 *                         the translator missed them
 *   - runTurn() error with open transport → health="degraded"
 *   - runTurn() error with closed transport → health="dead"
 *   - onUpdate fires for each translated notification
 *   - close() closes client + transport, health="dead"
 *   - close() before start is safe
 *   - close() is idempotent
 *   - timeout rejects after timeoutMs
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createGeminiStreamingRunner } from "#lib/runners/streaming/gemini-streaming.mjs";

/** A queue-driven fake ACP client that lets each test schedule the
 * exact responses it needs. Notification dispatch is exposed so the
 * test can fake the broker pushing session/update events. */
function makeFakeClient() {
  /** @type {Map<string, any[]>} */
  const responses = new Map();
  /** @type {Set<(n: any) => void>} */
  const handlers = new Set();
  const calls = [];
  let open = true;

  return {
    onNotification: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    request: vi.fn((method, params) => {
      calls.push({ method, params });
      const queue = responses.get(method) ?? [];
      const next = queue.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? {});
    }),
    notify: vi.fn(),
    onHealthChange: vi.fn(() => () => {}),
    healthState: () => "ready",
    close: vi.fn(async () => {
      open = false;
    }),
    isOpen: () => open,
    /* test helpers */
    _enqueue(method, value) {
      if (!responses.has(method)) responses.set(method, []);
      const arr = /** @type {any[]} */ (responses.get(method));
      arr.push(value);
    },
    _emit(notification) {
      for (const h of handlers) h(notification);
    },
    _calls: calls
  };
}

function makeFakeTransport() {
  let open = false;
  return {
    start: vi.fn(async () => {
      open = true;
    }),
    close: vi.fn(async () => {
      open = false;
    }),
    isOpen: () => open,
    send: vi.fn(),
    onMessage: vi.fn(),
    onHealthChange: vi.fn(),
    healthState: () => "ready",
    /* test helpers */
    _kill() {
      open = false;
    }
  };
}

/** @type {string} */
let tmpCostHome;
let savedCostEnv;

beforeEach(() => {
  // Sandbox the cost-record append so the test doesn't write to the
  // user's real $XDG_STATE_HOME.
  tmpCostHome = fs.mkdtempSync(path.join("/tmp", "stream-gem-"));
  savedCostEnv = process.env.XDG_STATE_HOME ?? "";
  process.env.XDG_STATE_HOME = tmpCostHome;
});

afterEach(() => {
  if (savedCostEnv) {
    process.env.XDG_STATE_HOME = savedCostEnv;
  } else {
    Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  }
  fs.rmSync(tmpCostHome, { recursive: true, force: true });
});

test("start() with no broker → rejects with actionable message", async () => {
  const runner = createGeminiStreamingRunner({
    probe: () => null,
    createTransport: /** @type {any} */ (() => makeFakeTransport()),
    createClient: /** @type {any} */ (() => makeFakeClient())
  });
  await expect(runner.start()).rejects.toThrow(/no live broker/);
  expect(runner.health()).toBe("dead");
});

test("start() happy path → initialize + session/new called once, health=healthy", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", { protocolVersion: 1 });
  client._enqueue("session/new", { sessionId: "sess-1" });

  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/broker.sock",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(client._calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
  expect(runner.health()).toBe("healthy");
});

test("start() rejects when broker returns no sessionId", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: null });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/broker.sock",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await expect(runner.start()).rejects.toThrow(/no sessionId/);
  expect(runner.health()).toBe("dead");
});

test("runTurn before start → rejects", async () => {
  const runner = createGeminiStreamingRunner({
    probe: () => null,
    createTransport: /** @type {any} */ (() => makeFakeTransport()),
    createClient: /** @type {any} */ (() => makeFakeClient())
  });
  await expect(runner.runTurn({ prompt: "hi" })).rejects.toThrow(/before start/);
});

test("runTurn forwards prompt + sessionId to session/prompt", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "sess-x" });
  client._enqueue("session/prompt", { stopReason: "stop", usage: null });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/broker.sock",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  await runner.runTurn({ prompt: "what is 2+2?" });
  const promptCall = client._calls.find((c) => c.method === "session/prompt");
  expect(promptCall).toBeDefined();
  expect(promptCall.params.sessionId).toBe("sess-x");
  expect(promptCall.params.prompt[0].text).toBe("what is 2+2?");
});

test("runTurn accumulates agent_message_chunk notifications", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  // Emit notifications BEFORE the response resolves by hooking into
  // the prompt enqueue: replace the queued response with a fn-like
  // sequence: emit chunks first, then resolve.
  client._enqueue("session/prompt", { stopReason: "stop" });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/broker.sock",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();

  // Drive notifications synchronously between start and runTurn —
  // simpler than trying to interleave with the promise.
  const turnPromise = runner.runTurn({ prompt: "hi" });
  client._emit({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "the " }
      }
    }
  });
  client._emit({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" }
      }
    }
  });
  const result = await turnPromise;
  expect(result.text).toBe("the answer");
  expect(result.chunkCount).toBe(2);
});

test("runTurn captures tool_call notifications", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  client._enqueue("session/prompt", { stopReason: "stop" });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  const turnPromise = runner.runTurn({ prompt: "x" });
  client._emit({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolName: "read_file",
        toolUseId: "tu-1",
        args: { path: "a.txt" }
      }
    }
  });
  const result = await turnPromise;
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0].toolName).toBe("read_file");
});

test("runTurn reads stopReason/usage from prompt response", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  client._enqueue("session/prompt", {
    stopReason: "max_turn_requests",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  const result = await runner.runTurn({ prompt: "x" });
  expect(result.reason).toBe("max_turn_requests");
  expect(result.usage.total_tokens).toBe(150);
});

test("runTurn error with transport still open → health=degraded", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  client._enqueue("session/prompt", new Error("model overloaded"));
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow(/overloaded/);
  expect(runner.health()).toBe("degraded");
});

test("runTurn error with closed transport → health=dead", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  client._enqueue("session/prompt", new Error("ECONNRESET"));
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  // Simulate the broker dying mid-turn.
  transport._kill();
  await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow();
  expect(runner.health()).toBe("dead");
});

test("onUpdate fires for each translated notification", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  client._enqueue("session/prompt", { stopReason: "stop" });
  const updates = [];
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  const turnPromise = runner.runTurn({
    prompt: "x",
    onUpdate: (u) => updates.push(u)
  });
  client._emit({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" }
      }
    }
  });
  client._emit({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" }
      }
    }
  });
  await turnPromise;
  expect(updates.length).toBe(2);
});

test("close() closes client + transport, health=dead", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  await runner.close();
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(runner.health()).toBe("dead");
});

test("close() before start is safe", async () => {
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => makeFakeTransport()),
    createClient: /** @type {any} */ (() => makeFakeClient())
  });
  await expect(runner.close()).resolves.toBeUndefined();
});

test("close() is idempotent", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  await runner.close();
  await runner.close();
  // close() should NOT call client.close twice (state cleared first call)
  expect(client.close).toHaveBeenCalledTimes(1);
});

test("turnTimeout: timeoutMs rejects after the elapsed time", async () => {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  client._enqueue("initialize", {});
  client._enqueue("session/new", { sessionId: "s" });
  // Make session/prompt hang forever — only the timeout rejects.
  client.request = vi.fn(async (method) => {
    if (method === "initialize") return {};
    if (method === "session/new") return { sessionId: "s" };
    return new Promise(() => {});
  });
  const runner = createGeminiStreamingRunner({
    probe: () => "/tmp/b",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client)
  });
  await runner.start();
  await expect(runner.runTurn({ prompt: "x", timeoutMs: 25 })).rejects.toThrow(/timed out/);
});
