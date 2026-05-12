/**
 * Unit tests for `lib/runners/streaming/claude-streaming.mjs`.
 *
 * The runner is built on `@agentclientprotocol/claude-agent-acp` and
 * speaks standard Zed ACP, so its surface area is almost identical to
 * the gemini streaming runner. These tests use the same fake-client
 * pattern as `streaming-gemini.test.mjs` and `streaming-codex.test.mjs`
 * so the three files read side-by-side.
 *
 * Coverage groups:
 *
 *   lifecycle:start   initialize / session/new ordering; health
 *                     transitions; transport / subscription cleanup
 *                     on failure; resolveEntry injection
 *   lifecycle:close   idempotency; close-before-start; teardown
 *                     order; runTurn after close
 *   runTurn:rpc       prompt content shape; sessionId propagation;
 *                     stopReason + usage from response
 *   runTurn:updates   agent_message_chunk / agent_thought_chunk /
 *                     tool_call / tool_result / usage_update /
 *                     turn_completed handling; updates[] ordering;
 *                     malformed-notification tolerance
 *   runTurn:streaming onUpdate fan-out; throwing handler tolerance
 *   runTurn:errors    rpc rejection paths; health=degraded vs dead;
 *                     timeout
 *   cost-recorder     transport: "claude-agent-acp" emitted on both
 *                     ok=true and ok=false paths; promptChars +
 *                     model propagation; resolveClaudeModel applied
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createClaudeStreamingRunner } from "#lib/runners/streaming/claude-streaming.mjs";

/**
 * Queue-driven fake JSON-RPC client. Same shape as the codex/gemini
 * test files; kept locally so each runner test stays self-contained.
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
 * Construct + start a runner with happy-path queued responses. Returns
 * the fixtures most tests use.
 *
 * @param {{ sessionId?: string, runnerOptions?: any }} [opts]
 */
async function startedRunner(opts = {}) {
  const transport = makeFakeTransport();
  const client = makeFakeClient();
  const sessionId = opts.sessionId ?? "sess_test";
  client._enqueue("initialize", { protocolVersion: 1, agentCapabilities: {} });
  client._enqueue("session/new", { sessionId });
  const runner = createClaudeStreamingRunner({
    cwd: "/tmp",
    createTransport: /** @type {any} */ (() => transport),
    createClient: /** @type {any} */ (() => client),
    resolveEntry: () => "/fake/claude-agent-acp/dist/index.js",
    ...opts.runnerOptions
  });
  await runner.start();
  return { runner, transport, client, sessionId };
}

/** @type {string} */
let tmpCostHome;
let savedCostEnv;

beforeEach(() => {
  tmpCostHome = fs.mkdtempSync(path.join("/tmp", "stream-cla-"));
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
  test("happy path → initialize + session/new called in order, health=healthy", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", { protocolVersion: 1 });
    client._enqueue("session/new", { sessionId: "sess_1" });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await runner.start();
    expect(transport.start).toHaveBeenCalledTimes(1);
    const order = client._calls.map((c) => c.method);
    expect(order).toEqual(["initialize", "session/new"]);
    expect(runner.health()).toBe("healthy");
  });

  test("initialize carries protocolVersion + clientCapabilities", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "s" });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      protocolVersion: 1,
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await runner.start();
    const init = client._calls.find((c) => c.method === "initialize");
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities).toBeTruthy();
  });

  test("session/new carries cwd + empty mcpServers", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "s" });
    const runner = createClaudeStreamingRunner({
      cwd: "/some/where",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await runner.start();
    const sn = client._calls.find((c) => c.method === "session/new");
    expect(sn.params.cwd).toBe("/some/where");
    expect(sn.params.mcpServers).toEqual([]);
  });

  test("resolveEntry is invoked exactly once, on start()", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "s" });
    const resolveEntry = vi.fn(() => "/fake/index.js");
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry
    });
    expect(resolveEntry).toHaveBeenCalledTimes(0);
    await runner.start();
    expect(resolveEntry).toHaveBeenCalledTimes(1);
  });

  test("explicit args override skips resolveEntry entirely", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "s" });
    const resolveEntry = vi.fn(() => "/should/not/be/called");
    const captured = vi.fn((opts) => {
      // Capture the transport-factory args for assertion below.
      captured.opts = opts;
      return transport;
    });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      command: "node",
      args: ["/custom/entry.mjs", "--debug"],
      createTransport: /** @type {any} */ (captured),
      createClient: /** @type {any} */ (() => client),
      resolveEntry
    });
    await runner.start();
    expect(resolveEntry).not.toHaveBeenCalled();
    expect(captured.opts.args).toEqual(["/custom/entry.mjs", "--debug"]);
    expect(captured.opts.command).toBe("node");
  });

  test("rejects when session/new returns no sessionId; health=dead, transport closed", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: null });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await expect(runner.start()).rejects.toThrow(/no sessionId/);
    expect(runner.health()).toBe("dead");
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  test("rejects when initialize errors; session/new not attempted", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", new Error("agent SDK unauthenticated"));
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await expect(runner.start()).rejects.toThrow(/unauthenticated/);
    expect(client._calls.some((c) => c.method === "session/new")).toBe(false);
    expect(runner.health()).toBe("dead");
  });

  test("rejects when transport.start fails", async () => {
    const transport = makeFakeTransport();
    transport.start = vi.fn(async () => {
      throw new Error("ENOENT claude-agent-acp");
    });
    const client = makeFakeClient();
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await expect(runner.start()).rejects.toThrow(/ENOENT/);
    expect(runner.health()).toBe("dead");
  });

  test("start() is idempotent — second call no-op", async () => {
    const { runner, client } = await startedRunner();
    const callCount = client._calls.length;
    await runner.start();
    expect(client._calls.length).toBe(callCount);
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:rpc
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:rpc", () => {
  test("rejects when called before start", async () => {
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => makeFakeTransport()),
      createClient: /** @type {any} */ (() => makeFakeClient()),
      resolveEntry: () => "/fake/index.js"
    });
    await expect(runner.runTurn({ prompt: "hi" })).rejects.toThrow(/before start/);
  });

  test("session/prompt carries sessionId + prompt as a content array", async () => {
    const { runner, client, sessionId } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "what is 2+2?" });
    const call = client._calls.find((c) => c.method === "session/prompt");
    expect(call.params.sessionId).toBe(sessionId);
    expect(call.params.prompt).toEqual([{ type: "text", text: "what is 2+2?" }]);
  });

  test("session/prompt response stopReason maps to turn.reason", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "max_tokens" });
    const result = await runner.runTurn({ prompt: "x" });
    expect(result.reason).toBe("max_tokens");
  });

  test("session/prompt response usage flows to turn.usage when not set by updates", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", {
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 9 }
    });
    const result = await runner.runTurn({ prompt: "x" });
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 9 });
  });

  test("turn-level model is resolved via resolveClaudeModel and lands on turn.model", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    // `claude-sonnet-4-6` is an Anthropic-SDK canonical id that
    // resolveClaudeModel maps onto the agent's short `sonnet` form.
    const result = await runner.runTurn({
      prompt: "x",
      model: "claude-sonnet-4-6"
    });
    expect(result.model).toBe("sonnet");
  });

  test("turn-level model fires session/set_model with the resolved id", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "x", model: "opus-1m" });
    const setModelCall = client._calls.find((c) => c.method === "session/set_model");
    expect(setModelCall).toBeDefined();
    // opus-1m / claude-opus-4-7-1m / opus / claude-opus-4-7 all
    // collapse onto the agent's `default` id (its only opus flavor).
    expect(setModelCall.params.modelId).toBe("default");
    expect(setModelCall.params.sessionId).toBeTruthy();
  });

  test("no model on turn AND no default → no session/set_model emitted", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "x" });
    expect(client._calls.some((c) => c.method === "session/set_model")).toBe(false);
  });

  test("second turn with same model skips the set_model round-trip", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", model: "haiku" });
    await runner.runTurn({ prompt: "2", model: "haiku" });
    const setModelCalls = client._calls.filter((c) => c.method === "session/set_model");
    expect(setModelCalls).toHaveLength(1);
  });

  test("changing model on the second turn re-applies", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", model: "haiku" });
    await runner.runTurn({ prompt: "2", model: "opus" });
    const setModelCalls = client._calls.filter((c) => c.method === "session/set_model");
    expect(setModelCalls).toHaveLength(2);
    // opus → `default` (claude-agent-acp's only opus flavor).
    expect(setModelCalls[1].params.modelId).toBe("default");
  });

  test("fresh session resets applied-model — set_model re-fires for same alias", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/new", { sessionId: "sess-fresh" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", model: "sonnet" });
    await runner.runTurn(
      { prompt: "2", model: "sonnet" },
      /** @type {any} */ ({ session: { action: "fresh" } })
    );
    const setModelCalls = client._calls.filter((c) => c.method === "session/set_model");
    // Same alias on both turns — but the fresh-session reset forces
    // a re-apply. Otherwise the fresh session would have NO model.
    expect(setModelCalls).toHaveLength(2);
    expect(setModelCalls[1].params.sessionId).toBe("sess-fresh");
  });

  test("session/set_model rejection aborts the turn before session/prompt", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/set_model", new Error("unknown model id"));
    await expect(runner.runTurn({ prompt: "x", model: "claude-not-a-real-model" })).rejects.toThrow(
      /unknown model id/
    );
    // No prompt should have been issued.
    expect(client._calls.some((c) => c.method === "session/prompt")).toBe(false);
  });

  test("turn-level effort fires session/set_config_option(effort)", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "x", effort: "max" });
    const cfgCall = client._calls.find((c) => c.method === "session/set_config_option");
    expect(cfgCall).toBeDefined();
    expect(cfgCall.params.configId).toBe("effort");
    expect(cfgCall.params.value).toBe("max");
    expect(cfgCall.params.sessionId).toBeTruthy();
  });

  test("no effort on turn → no session/set_config_option emitted", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "x" });
    expect(client._calls.some((c) => c.method === "session/set_config_option")).toBe(false);
  });

  test("repeated turn with same effort skips the round-trip", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", effort: "high" });
    await runner.runTurn({ prompt: "2", effort: "high" });
    const cfgCalls = client._calls.filter((c) => c.method === "session/set_config_option");
    expect(cfgCalls).toHaveLength(1);
  });

  test("fresh session resets applied-effort — re-fires for same value", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/new", { sessionId: "sess-fresh" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", effort: "medium" });
    await runner.runTurn(
      { prompt: "2", effort: "medium" },
      /** @type {any} */ ({ session: { action: "fresh" } })
    );
    const cfgCalls = client._calls.filter((c) => c.method === "session/set_config_option");
    expect(cfgCalls).toHaveLength(2);
    expect(cfgCalls[1].params.sessionId).toBe("sess-fresh");
  });

  test("set_model invalidates applied-effort — subsequent effort re-applies", async () => {
    // claude-agent-acp rebuilds the effort catalog after a model
    // switch (effort levels depend on the model). Without the cache
    // invalidation, turn 2's set_config_option would no-op believing
    // effort is unchanged, but the agent would silently use a
    // different effort.
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    await runner.runTurn({ prompt: "1", model: "sonnet", effort: "high" });
    await runner.runTurn({ prompt: "2", model: "opus", effort: "high" });
    const cfgCalls = client._calls.filter((c) => c.method === "session/set_config_option");
    // Both turns must re-issue set_config_option because turn 2's
    // set_model invalidated the effort cache.
    expect(cfgCalls).toHaveLength(2);
    expect(cfgCalls[1].params.value).toBe("high");
  });

  test("set_config_option rejection aborts the turn before session/prompt", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/set_config_option", new Error("unknown effort"));
    await expect(
      runner.runTurn({ prompt: "x", effort: /** @type {any} */ ("ludicrous") })
    ).rejects.toThrow(/unknown effort/);
    expect(client._calls.some((c) => c.method === "session/prompt")).toBe(false);
  });

  test("start() applies the factory's defaultModel via set_model", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "sess-default" });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      model: "opus-1m",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await runner.start();
    const setModelCall = client._calls.find((c) => c.method === "session/set_model");
    expect(setModelCall).toBeDefined();
    // opus-1m collapses onto `default` (the agent's 1M-context opus id).
    expect(setModelCall.params.modelId).toBe("default");
    expect(setModelCall.params.sessionId).toBe("sess-default");
  });

  test("context.session.fresh → session/new before session/prompt; new id wins", async () => {
    const { runner, client } = await startedRunner({ sessionId: "sess-orig" });
    client._enqueue("session/new", { sessionId: "sess-fresh" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const result = await runner.runTurn(
      { prompt: "x" },
      /** @type {any} */ ({ session: { action: "fresh" } })
    );
    const promptCall = client._calls.find((c) => c.method === "session/prompt");
    expect(promptCall.params.sessionId).toBe("sess-fresh");
    expect(result.sessionId).toBe("sess-fresh");
  });

  test("context.session.id → session/load with that id; that id wins", async () => {
    const { runner, client } = await startedRunner({ sessionId: "sess-orig" });
    client._enqueue("session/load", {});
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const result = await runner.runTurn(
      { prompt: "x" },
      /** @type {any} */ ({
        session: { action: "resume", id: "sess-resumed" }
      })
    );
    const loadCall = client._calls.find((c) => c.method === "session/load");
    expect(loadCall.params.sessionId).toBe("sess-resumed");
    const promptCall = client._calls.find((c) => c.method === "session/prompt");
    expect(promptCall.params.sessionId).toBe("sess-resumed");
    expect(result.sessionId).toBe("sess-resumed");
  });

  test("no context.session → reuses sessionId from start() (warm path)", async () => {
    const { runner, client, sessionId } = await startedRunner({
      sessionId: "sess-orig"
    });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const result = await runner.runTurn({ prompt: "x" });
    const methods = client._calls.map((c) => c.method);
    // no extra session/new or session/load
    expect(methods).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(result.sessionId).toBe(sessionId);
  });

  test("factory-level model is used when the turn does not override", async () => {
    const transport = makeFakeTransport();
    const client = makeFakeClient();
    client._enqueue("initialize", {});
    client._enqueue("session/new", { sessionId: "s" });
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      model: "opus",
      createTransport: /** @type {any} */ (() => transport),
      createClient: /** @type {any} */ (() => client),
      resolveEntry: () => "/fake/index.js"
    });
    await runner.start();
    const result = await runner.runTurn({ prompt: "x" });
    expect(result.model).toBeTruthy();
    expect(result.model).not.toBe("opus");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:abort — caller signal must (a) fast-fail when pre-aborted,
// (b) dispatch session/cancel during pre-prompt setup, and (c) unwedge
// the work promise when session/prompt is in flight. See F9 in
// claude-streaming.mjs runTurn.
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:abort", () => {
  test("pre-aborted signal throws before any setup call", async () => {
    const { runner, client } = await startedRunner();
    const ac = new AbortController();
    ac.abort();
    const callsBefore = client._calls.length;
    await expect(runner.runTurn({ prompt: "x", signal: ac.signal })).rejects.toThrow();
    // No session/prompt, set_model, set_config_option, or cancel issued.
    const after = client._calls.slice(callsBefore);
    expect(after.some((c) => c.method === "session/prompt")).toBe(false);
    expect(after.some((c) => c.method === "session/set_model")).toBe(false);
    expect(after.some((c) => c.method === "session/set_config_option")).toBe(false);
    expect(after.some((c) => c.method === "session/cancel")).toBe(false);
  });

  test("abort during set_model fires session/cancel before resolution", async () => {
    const { runner, client } = await startedRunner();
    const ac = new AbortController();
    // Make set_model hang so we can fire abort mid-call.
    let releaseSetModel;
    const setModelHang = new Promise((resolve) => {
      releaseSetModel = () => resolve({});
    });
    client._enqueue("session/set_model", setModelHang);
    const turnPromise = runner.runTurn({
      prompt: "x",
      model: "sonnet",
      signal: ac.signal
    });
    // Yield so runTurn enters its try block and dispatches set_model.
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    // Release the hung set_model so the turn can unwind.
    releaseSetModel({});
    await expect(turnPromise).rejects.toThrow();
    // session/cancel must have been dispatched by the abort handler.
    expect(client._calls.some((c) => c.method === "session/cancel" && c.kind === "notify")).toBe(
      true
    );
  });

  test("abort during session/prompt unwedges work promise immediately", async () => {
    const { runner, client } = await startedRunner();
    const ac = new AbortController();
    // session/prompt hangs forever — only the abort racer can unblock.
    client._enqueue("session/prompt", new Promise(() => {}));
    const turnPromise = runner.runTurn({
      prompt: "x",
      signal: ac.signal
    });
    // Yield so session/prompt is in flight before we abort.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await expect(turnPromise).rejects.toThrow();
    expect(client._calls.some((c) => c.method === "session/cancel" && c.kind === "notify")).toBe(
      true
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:updates
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:updates", () => {
  test("agent_message_chunk accumulates text + chunkCount + chunkChars", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
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
    expect(result.chunkChars).toBe("the answer".length);
  });

  test("agent_thought_chunk accumulates thoughtText separately", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking..." }
        }
      }
    });
    const result = await turnPromise;
    expect(result.thoughtText).toBe("thinking...");
    expect(result.thoughtCount).toBe(1);
    expect(result.text).toBe("");
  });

  test("tool_call notifications populate toolCalls", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolName: "read_file",
          toolUseId: "tu_1",
          args: { path: "a.txt" }
        }
      }
    });
    const result = await turnPromise;
    expect(result.toolCalls).toEqual([
      { toolName: "read_file", toolUseId: "tu_1", args: { path: "a.txt" } }
    ]);
  });

  test("tool_result notifications populate toolResults; isError is coerced to boolean", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_result",
          toolUseId: "tu_1",
          result: { ok: true },
          isError: 0 // truthy-but-not-boolean coercion check
        }
      }
    });
    const result = await turnPromise;
    expect(result.toolResults).toEqual([
      { toolUseId: "tu_1", result: { ok: true }, isError: false }
    ]);
  });

  test("usage_update propagates to turn.usage (last-write-wins within updates)", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "usage_update",
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      }
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "usage_update",
          usage: { input_tokens: 11, output_tokens: 21 }
        }
      }
    });
    const result = await turnPromise;
    expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 21 });
  });

  test("turn_completed reason/usage/model are captured when emitted as a session/update", async () => {
    const { runner, client } = await startedRunner();
    // Response stopReason is null/missing — turn_completed update fills in.
    client._enqueue("session/prompt", {});
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
          model: "claude-sonnet-4-6"
        }
      }
    });
    const result = await turnPromise;
    expect(result.reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("turn.reason from updates is NOT overwritten by response.stopReason (first-wins)", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "from_response" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: { sessionUpdate: "turn_completed", reason: "from_update" }
      }
    });
    const result = await turnPromise;
    expect(result.reason).toBe("from_update");
  });

  test("updates[] preserves the order of emission", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "a" }
        }
      }
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolName: "x",
          toolUseId: "t1",
          args: {}
        }
      }
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "b" }
        }
      }
    });
    const result = await turnPromise;
    expect(result.updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "agent_message_chunk"
    ]);
  });

  test("ignores notifications outside an active turn (no throw)", async () => {
    const { client } = await startedRunner();
    expect(() =>
      client._emit({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "stray" }
          }
        }
      })
    ).not.toThrow();
  });

  test("non-session/update notifications are ignored", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "some/other/event",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "x" }
        }
      }
    });
    const result = await turnPromise;
    expect(result.text).toBe("");
  });

  test("malformed session/update notifications are dropped silently", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({ method: "session/update", params: null });
    client._emit({ method: "session/update", params: {} });
    client._emit({ method: "session/update", params: { update: null } });
    client._emit({
      method: "session/update",
      params: { update: { sessionUpdate: 123 } }
    });
    const result = await turnPromise;
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  test("unknown sessionUpdate kinds still record into updates[] without crashing", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({ prompt: "x" });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "future_kind_we_dont_know_yet",
          arbitrary: 42
        }
      }
    });
    const result = await turnPromise;
    expect(result.updates.map((u) => u.sessionUpdate)).toEqual(["future_kind_we_dont_know_yet"]);
    expect(result.text).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:streaming
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:streaming", () => {
  test("onUpdate fires for every translated SessionUpdate", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const seen = [];
    const turnPromise = runner.runTurn({
      prompt: "x",
      onUpdate: (u) => seen.push(u.sessionUpdate)
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "a" }
        }
      }
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolName: "x",
          toolUseId: "t1",
          args: {}
        }
      }
    });
    await turnPromise;
    expect(seen).toEqual(["agent_message_chunk", "tool_call"]);
  });

  test("throwing onUpdate handler does not break the turn", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    const turnPromise = runner.runTurn({
      prompt: "x",
      onUpdate: () => {
        throw new Error("listener bug");
      }
    });
    client._emit({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "ok" }
        }
      }
    });
    const result = await turnPromise;
    expect(result.text).toBe("ok");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runTurn:errors
// ──────────────────────────────────────────────────────────────────────

describe("runTurn:errors", () => {
  test("session/prompt rejection with transport open → health=degraded", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", new Error("Anthropic 529 overloaded"));
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow(/overloaded/);
    expect(runner.health()).toBe("degraded");
  });

  test("session/prompt rejection with transport killed → health=dead", async () => {
    const { runner, transport, client } = await startedRunner();
    client._enqueue("session/prompt", new Error("EPIPE"));
    transport._kill();
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow();
    expect(runner.health()).toBe("dead");
  });

  test("session/prompt that never resolves is killed by timeout", async () => {
    const { runner, client } = await startedRunner();
    client.request = vi.fn(async (method) => {
      if (method === "initialize") return {};
      if (method === "session/new") return { sessionId: "s" };
      return new Promise(() => {}); // hang forever
    });
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 25 })).rejects.toThrow(/timed out/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// lifecycle:close
// ──────────────────────────────────────────────────────────────────────

describe("lifecycle:close", () => {
  test("close() unsubscribes, closes client + transport, health=dead", async () => {
    const { runner, transport, client } = await startedRunner();
    await runner.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(runner.health()).toBe("dead");
  });

  test("close() before start is safe", async () => {
    const runner = createClaudeStreamingRunner({
      cwd: "/tmp",
      createTransport: /** @type {any} */ (() => makeFakeTransport()),
      createClient: /** @type {any} */ (() => makeFakeClient()),
      resolveEntry: () => "/fake/index.js"
    });
    await expect(runner.close()).resolves.toBeUndefined();
  });

  test("close() is idempotent — second call does not re-close client", async () => {
    const { runner, client } = await startedRunner();
    await runner.close();
    await runner.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("runTurn after close rejects with before-start error", async () => {
    const { runner } = await startedRunner();
    await runner.close();
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow(/before start/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// cost-recorder
// ──────────────────────────────────────────────────────────────────────

describe("cost-recorder", () => {
  test("successful turn writes record with transport=claude-agent-acp + ok=true", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", {
      stopReason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 }
    });
    await runner.runTurn({ prompt: "five chars" });
    const log = readCostLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      backend: "claude",
      transport: "claude-agent-acp",
      ok: true,
      promptChars: "five chars".length,
      reason: "end_turn"
    });
    expect(log[0].usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 4
    });
  });

  test("failed turn writes record with ok=false and same transport label", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", new Error("boom"));
    await expect(runner.runTurn({ prompt: "x" })).rejects.toThrow();
    const log = readCostLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ ok: false, transport: "claude-agent-acp" });
  });

  test("turn-level model override is resolved before being recorded", async () => {
    const { runner, client } = await startedRunner();
    client._enqueue("session/prompt", { stopReason: "end_turn" });
    // `claude-haiku-4-5` (SDK canonical) → `haiku` (agent-acp id) is
    // resolved at runner entry, so the cost log stores the resolved
    // value, not the user-facing canonical alias.
    await runner.runTurn({ prompt: "x", model: "claude-haiku-4-5" });
    const log = readCostLog();
    expect(log[0].model).toBe("haiku");
  });

  test("timeout path still emits a cost record with ok=false", async () => {
    const { runner, client } = await startedRunner();
    client.request = vi.fn(async (method) => {
      if (method === "initialize") return {};
      if (method === "session/new") return { sessionId: "s" };
      return new Promise(() => {});
    });
    await expect(runner.runTurn({ prompt: "x", timeoutMs: 25 })).rejects.toThrow();
    const log = readCostLog();
    expect(log.at(-1)).toMatchObject({
      ok: false,
      transport: "claude-agent-acp"
    });
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
