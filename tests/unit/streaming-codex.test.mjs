/**
 * Unit tests for `lib/runners/streaming/codex-streaming.mjs`.
 *
 * The runner depends on two injectables (`createTransport`,
 * `createClient`). Both are stubbed here so the test never spawns a
 * process. The mocks mirror `streaming-gemini.test.mjs`'s shape so
 * future readers can compare the two runners side-by-side.
 *
 * Coverage groups (mapped to the runner's surface):
 *
 *   lifecycle:start    initialize / initialized / thread/start order;
 *                      health transitions; error cleanup
 *   lifecycle:close    idempotency; close-before-start; teardown order
 *   runTurn:rpc        turn/start request shape; threadId + model
 *                      propagation; awaiting turn/completed notification
 *   runTurn:items      item/agentMessage/delta accumulation; tool_call
 *                      / tool_result for non-agentMessage items; error
 *                      classification from status / exitCode
 *   runTurn:meta       turn/completed reason+usage; tokenUsage updates;
 *                      explicit usage on response
 *   runTurn:streaming  onUpdate fan-out; tolerant of throwing handlers
 *   runTurn:errors     rpc rejection paths; health=degraded vs dead;
 *                      timeout rejection
 *   cost-recorder      transport: "codex-app-server"; ok flag; model +
 *                      promptChars propagation
 *   translation        extractToolArgs / extractToolResult shape
 *                      handling for the three observed item shapes
 *                      (commandExecution, functionCall, generic)
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCodexStreamingRunner } from "#lib/runners/streaming/codex-streaming.mjs";

/**
 * Queue-driven fake JSON-RPC client. Mirrors the shape used in
 * `streaming-gemini.test.mjs::makeFakeClient` so the two test files
 * read identically. Notifications and request responses are scheduled
 * by the test; `_emit` pushes a notification into every subscribed
 * handler.
 */
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
    notify: vi.fn((method, params) => {
      calls.push({ method, params, kind: "notify" });
    }),
    onHealthChange: vi.fn(() => () => {}),
    healthState: () => "ready",
    close: vi.fn(async () => {
      open = false;
    }),
    isOpen: () => open,
    /* test helpers */
    _enqueue(method, value) {
      if (!responses.has(method)) responses.set(method, []);
      /** @type {any[]} */ (responses.get(method)).push(value);
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
    _kill() {
      open = false;
    }
  };
}

/**
 * Standard "happy-path start" helper. Returns the four pieces a test
 * usually wants — runner, transport, client, and a function to drive
 * a complete turn by emitting turn/completed.
 *
 * @param {{ threadId?: string, prePrompt?: () => void, runnerOptions?: any }} [opts]
 */
async function startedRunner(opts = {}) {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  const threadId = opts.threadId ?? "thr_test";
  client._enqueue("initialize", { userAgent: "codex/test" });
  client._enqueue("thread/start", { thread: { id: threadId } });
  const runner = createCodexStreamingRunner({
    cwd: "/tmp",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client),
    ...opts.runnerOptions
  });
  await runner.start();
  if (opts.prePrompt) opts.prePrompt();
  return { runner, transport, client, threadId };
}

/** @type {string} */
let tmpCostHome;
let savedCostEnv;

beforeEach(() => {
  // Sandbox the cost-record append so the test doesn't write to the
  // user's real $XDG_STATE_HOME.
  tmpCostHome = fs.mkdtempSync(path.join("/tmp", "stream-cdx-"));
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

// ──────────────────────────────────────────────────────────────────────
// lifecycle:start
// ──────────────────────────────────────────────────────────────────────

describe("lifecycle:start", () => {
  test("happy path → initialize + initialized notify + thread/start called in order, health=healthy", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", { userAgent: "codex/test" });
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    expect(transport.start).toHaveBeenCalledTimes(1);
    const methodOrder = client._calls.map(
      (c) => `${c.kind === "notify" ? "notify:" : ""}${c.method}`
    );
    expect(methodOrder).toEqual(["initialize", "notify:initialized", "thread/start"]);
    expect(runner.health()).toBe("healthy");
  });

  test("initialize is called with the artagon clientInfo", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    const initCall = client._calls.find((c) => c.method === "initialize");
    expect(initCall.params.clientInfo.name).toBe("artagon-codex-streaming");
    expect(typeof initCall.params.clientInfo.version).toBe("string");
  });

  test("thread/start carries cwd", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/some/where",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    const threadCall = client._calls.find((c) => c.method === "thread/start");
    expect(threadCall.params.cwd).toBe("/some/where");
  });

  test("thread/start carries resolved model when factory option is set", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      model: "gpt-5-codex",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    const threadCall = client._calls.find((c) => c.method === "thread/start");
    expect(threadCall.params.model).toBe("gpt-5-codex");
  });

  test("thread/start omits model when no factory option is set", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    const threadCall = client._calls.find((c) => c.method === "thread/start");
    expect(threadCall.params.model).toBeUndefined();
  });

  test("rejects when thread/start returns no thread id; health=dead and transport closed", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: null } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await expect(runner.start()).rejects.toThrow(/no thread id/);
    expect(runner.health()).toBe("dead");
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  test("rejects when initialize errors; thread/start is not attempted; health=dead", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", new Error("not-initialized"));
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await expect(runner.start()).rejects.toThrow(/not-initialized/);
    expect(client._calls.some((c) => c.method === "thread/start")).toBe(false);
    expect(runner.health()).toBe("dead");
  });

  test("rejects when transport.start fails; client subscription is still released", async () => {
    const transport = makeFakeTransport();
    transport.start = vi.fn(async () => {
      throw new Error("ENOENT codex");
    });
    const client = makeFakeClient();
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await expect(runner.start()).rejects.toThrow(/ENOENT codex/);
    expect(runner.health()).toBe("dead");
  });

  test("start() is idempotent — second call is a no-op", async () => {
    const { runner, client } = await startedRunner();
    const callCountAfterFirst = client._calls.length;
    await runner.start();
    expect(client._calls.length).toBe(callCountAfterFirst);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:rpc
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:rpc", () => {
  test("rejects when runTurn is called before start", async () => {
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => makeFakeTransport()),
      createClient: /** @type {any} */ (() => makeFakeClient())
    });
    await expect(runner.runTurn({ prompt: "hi" })).rejects.toThrow(/before start/);
  });

  test("forwards prompt + threadId to turn/start", async () => {
    const { runner, client, threadId } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "what is 2+2?" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    const startCall = client._calls.find((c) => c.method === "turn/start");
    expect(startCall).toBeDefined();
    expect(startCall.params.threadId).toBe(threadId);
    expect(startCall.params.userInput).toBe("what is 2+2?");
  });

  test("turn-level model override resolves via resolveCodexModel and lands on turn/start", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x", model: "gpt-5-codex" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    const startCall = client._calls.find((c) => c.method === "turn/start");
    expect(startCall.params.model).toBe("gpt-5-codex");
  });

  test("turn/start response is acknowledgment only — runTurn waits for turn/completed", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    // No turn/completed yet → microtask flush should not resolve.
    let resolved = false;
    turnPromise
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    // Emit completion → turn settles.
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    expect(resolved).toBe(true);
  });

  test("turn.model from turn/start response is picked up when set", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", {
      turn: { id: "tr_1", model: "gpt-5.1-codex" }
    });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.model).toBe("gpt-5.1-codex");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:items
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:items", () => {
  test("accumulates item/agentMessage/delta into text + chunkCount + chunkChars", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "hi" });
    client._emit({
      method: "item/agentMessage/delta",
      params: { itemId: "m1", delta: "the " }
    });
    client._emit({
      method: "item/agentMessage/delta",
      params: { itemId: "m1", delta: "answer" }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.text).toBe("the answer");
    expect(result.chunkCount).toBe(2);
    expect(result.chunkChars).toBe("the answer".length);
  });

  test("captures commandExecution items as tool_call + tool_result with paired ids", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "list files" });
    client._emit({
      method: "item/started",
      params: {
        item: {
          id: "cmd_1",
          type: "commandExecution",
          command: ["ls"],
          cwd: "/tmp",
          status: "inProgress"
        }
      }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: {
          id: "cmd_1",
          type: "commandExecution",
          status: "completed",
          exitCode: 0,
          output: "a.txt\n"
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolCalls).toEqual([
      {
        toolName: "commandExecution",
        toolUseId: "cmd_1",
        args: { command: ["ls"], cwd: "/tmp" }
      }
    ]);
    expect(result.toolResults).toEqual([
      {
        toolUseId: "cmd_1",
        result: { output: "a.txt\n", exitCode: 0 },
        isError: false
      }
    ]);
  });

  test("non-zero exitCode classifies the tool_result as isError=true", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "fail" });
    client._emit({
      method: "item/started",
      params: {
        item: { id: "cmd_1", type: "commandExecution", command: ["false"] }
      }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: {
          id: "cmd_1",
          type: "commandExecution",
          status: "completed",
          exitCode: 1
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolResults[0].isError).toBe(true);
  });

  test("status=failed classifies the tool_result as isError=true", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "fail" });
    client._emit({
      method: "item/started",
      params: {
        item: {
          id: "fn_1",
          type: "functionCall",
          arguments: { id: "ticket-7" }
        }
      }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: {
          id: "fn_1",
          type: "functionCall",
          status: "failed",
          result: { msg: "boom" }
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolResults[0].isError).toBe(true);
    expect(result.toolResults[0].result).toEqual({ msg: "boom" });
  });

  test("ignores item/started with type=agentMessage (text delta path handles them)", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: { item: { id: "m1", type: "agentMessage", text: "" } }
    });
    client._emit({
      method: "item/completed",
      params: { item: { id: "m1", type: "agentMessage", text: "hello" } }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
  });

  test("drops malformed notifications without throwing", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    // Various malformed shapes — none should throw.
    client._emit({ method: "item/started", params: null });
    client._emit({ method: "item/started", params: {} });
    client._emit({ method: "item/started", params: { item: null } });
    client._emit({
      method: "item/started",
      params: { item: { type: "commandExecution" } }
    }); // no id
    client._emit({
      method: "item/completed",
      params: { item: { type: "commandExecution" } }
    });
    client._emit({
      method: "item/agentMessage/delta",
      params: { itemId: "m1" }
    }); // no delta
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  test("ignores notifications received between turns", async () => {
    const { runner, client } = await startedRunner();
    // Emit a stray notification with no active turn — must not throw.
    expect(() =>
      client._emit({
        method: "item/agentMessage/delta",
        params: { delta: "stray" }
      })
    ).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:meta
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:meta", () => {
  test("turn/completed status maps to reason", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.reason).toBe("completed");
  });

  test("turn/completed tokenUsage maps to usage", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          tokenUsage: { input_tokens: 12, output_tokens: 34 }
        }
      }
    });
    const result = await turnPromise;
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
  });

  test("thread/tokenUsage/updated post-completion override is captured before runTurn resolves", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr_test",
        usage: { input_tokens: 7, output_tokens: 3 }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  test("turn/completed does NOT overwrite an already-set usage from earlier thread/tokenUsage/updated", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "thread/tokenUsage/updated",
      params: { usage: { input_tokens: 50, output_tokens: 50 } }
    });
    client._emit({
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          tokenUsage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    });
    const result = await turnPromise;
    // First-wins (matches `if (!activeTurn.usage)`).
    expect(result.usage.input_tokens).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:streaming
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:streaming", () => {
  test("onUpdate fires for every emitted SessionUpdate (delta, tool_call, tool_result, turn_completed)", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const updates = [];
    const turnPromise = runner.runTurn({
      prompt: "x",
      onUpdate: (u) => updates.push(u.sessionUpdate)
    });
    client._emit({
      method: "item/agentMessage/delta",
      params: { itemId: "m1", delta: "hi" }
    });
    client._emit({
      method: "item/started",
      params: {
        item: { id: "cmd_1", type: "commandExecution", command: ["ls"] }
      }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: {
          id: "cmd_1",
          type: "commandExecution",
          exitCode: 0,
          output: ""
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    expect(updates).toEqual(["agent_message_chunk", "tool_call", "tool_result", "turn_completed"]);
  });

  test("onUpdate handler that throws does not break the turn", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({
      prompt: "x",
      onUpdate: () => {
        throw new Error("listener bug");
      }
    });
    client._emit({
      method: "item/agentMessage/delta",
      params: { delta: "ok" }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.text).toBe("ok");
  });

  test("updates[] preserves the order of emission", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({ method: "item/agentMessage/delta", params: { delta: "1" } });
    client._emit({
      method: "item/started",
      params: { item: { id: "c", type: "commandExecution", command: ["a"] } }
    });
    client._emit({ method: "item/agentMessage/delta", params: { delta: "2" } });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    const kinds = result.updates.map((u) => u.sessionUpdate);
    expect(kinds).toEqual([
      "agent_message_chunk",
      "tool_call",
      "agent_message_chunk",
      "turn_completed"
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:errors
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:errors", () => {
  test("turn/start rpc error with transport open → health=degraded", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", new Error("model overloaded"));
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 5000 })).rejects.toThrow(/overloaded/);
    expect(runner.health()).toBe("degraded");
  });

  test("turn/start rpc error after transport killed → health=dead", async () => {
    const { runner, transport, client } = await startedRunner();
    client._enqueue("turn/start", new Error("ECONNRESET"));
    transport._kill();
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 5000 })).rejects.toThrow();
    expect(runner.health()).toBe("dead");
  });

  test("turn that hangs without turn/completed times out after timeoutMs", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    // Never emit turn/completed — only the timer fires.
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 25 })).rejects.toThrow(/timed out/);
  });

  test("timeout writes a cost record with ok=false", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 25 })).rejects.toThrow();
    const log = readCostLog();
    expect(log.at(-1)).toMatchObject({
      ok: false,
      transport: "codex-app-server"
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// lifecycle:close
// ──────────────────────────────────────────────────────────────────────

describe("lifecycle:close", () => {
  test("close() unsubscribes notifications, closes client + transport, health=dead", async () => {
    const { runner, transport, client } = await startedRunner();
    await runner.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(runner.health()).toBe("dead");
  });

  test("close() before start is safe", async () => {
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => makeFakeTransport()),
      createClient: /** @type {any} */ (() => makeFakeClient())
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  test("close() is idempotent — second call does not re-close client", async () => {
    const { runner, client } = await startedRunner();
    await runner.close();
    await runner.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("after close, runTurn rejects with before-start error", async () => {
    const { runner } = await startedRunner();
    await runner.close();
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow(/before start/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// cost-recorder
// ──────────────────────────────────────────────────────────────────────

describe("cost-recorder", () => {
  test("successful turn appends a record with transport=codex-app-server and ok=true", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "five chars" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    const log = readCostLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      backend: "codex",
      transport: "codex-app-server",
      ok: true,
      promptChars: "five chars".length,
      reason: "completed"
    });
  });

  test("failed turn appends a record with ok=false and the same transport label", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", new Error("boom"));
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow();
    const log = readCostLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ ok: false, transport: "codex-app-server" });
  });

  test("turn-level model override appears on the cost record", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x", model: "o4-mini" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    const log = readCostLog();
    expect(log[0].model).toBe("o4-mini");
  });

  test("factory-level model is used when the turn does not override", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("thread/start", { thread: { id: "thr_1" } });
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const runner = createCodexStreamingRunner({
      cwd: "/tmp",
      model: "spark",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client)
    });
    await runner.start();
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    await turnPromise;
    expect(readCostLog()[0].model).toBe("spark");
  });

  test("normalized usage carries through to the cost record when tokenUsage is provided", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          tokenUsage: { input_tokens: 5, output_tokens: 7 }
        }
      }
    });
    await turnPromise;
    expect(readCostLog()[0].usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 7
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// translation (extractToolArgs / extractToolResult shape coverage)
// ──────────────────────────────────────────────────────────────────────

describe("translation", () => {
  test("commandExecution item exposes command + cwd in tool_call args", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: {
        item: {
          id: "c",
          type: "commandExecution",
          command: ["echo", "hi"],
          cwd: "/x"
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolCalls[0].args).toEqual({
      command: ["echo", "hi"],
      cwd: "/x"
    });
  });

  test("functionCall item exposes arguments in tool_call args", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: {
        item: { id: "fn", type: "functionCall", arguments: { id: "T-1" } }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolCalls[0].args).toEqual({ id: "T-1" });
  });

  test("input-shaped items fall back to the `input` field for args", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: {
        item: { id: "tool", type: "unknownTool", input: { foo: "bar" } }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolCalls[0].args).toEqual({ foo: "bar" });
  });

  test("commandExecution result carries output + exitCode shape", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: { item: { id: "c", type: "commandExecution", command: ["ls"] } }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: { id: "c", type: "commandExecution", output: "hi", exitCode: 0 }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolResults[0].result).toEqual({ output: "hi", exitCode: 0 });
  });

  test("functionCall result passes through item.result verbatim", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("turn/start", { turn: { id: "tr_1" } });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "item/started",
      params: { item: { id: "fn", type: "functionCall", arguments: {} } }
    });
    client._emit({
      method: "item/completed",
      params: {
        item: {
          id: "fn",
          type: "functionCall",
          result: { ticket: { id: "T-1" } }
        }
      }
    });
    client._emit({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });
    const result = await turnPromise;
    expect(result.toolResults[0].result).toEqual({ ticket: { id: "T-1" } });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function readCostLog() {
  const logPath = path.join(tmpCostHome, "artagon-agent-cli-plugin", "cost.jsonl");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}
