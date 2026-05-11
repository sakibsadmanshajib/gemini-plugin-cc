/**
 * Codex streaming runner — keeps one `codex app-server` subprocess open
 * across many turns, framing codex's own JSON-RPC 2.0 protocol over
 * stdio and translating the streamed `thread/`/`turn/`/`item/` events
 * into the project's `SessionUpdate` shape.
 *
 * This is the Option-B warm path for codex: spawn-once, drive-many.
 * Companion to `gemini-streaming.mjs`. The protocol differences are
 * confined to this file — the supervisor, registry, dispatcher, and
 * cost recorder treat both backends uniformly.
 *
 * Sequence in start():
 *   spawn `codex app-server --listen stdio://`
 *     → initialize (request)            ← required first call per app-server spec
 *     → initialized (notification)      ← per JSON-RPC 2.0 convention
 *     → thread/start (request)          ← creates the long-lived conversation thread
 *
 * Sequence in runTurn():
 *   turn/start (request)               ← server responds immediately with empty turn
 *   wait for:
 *     item/started, item/agentMessage/delta, item/completed, ...   (streamed updates)
 *     turn/completed                                                (terminal)
 *     thread/tokenUsage/updated                                     (post-terminal usage)
 *
 * Why not reuse the gemini streaming runner's broker probe:
 *   codex doesn't have an external broker daemon; the runner owns the
 *   subprocess directly. Spawning is via lib/transport/cli.mjs's
 *   createCliTransport, which is the same transport the (currently
 *   dead) codexBackend declaration uses.
 *
 * Why not vendor the full app-server schema (Option A's translator):
 *   This is Option B — the minimum surface that gets /codex:prompt
 *   warm. The mapping is small enough to inline. Option A's
 *   `lib/translate/codex-app-server.mjs` will subsume this when it
 *   lands.
 */

import { resolveCodexModel } from "#lib/backends/codex.mjs";
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { createCliTransport } from "#lib/transport/cli.mjs";

import { createAcpClient } from "../../acp/client.mjs";

const DEFAULT_COMMAND = "codex";
const DEFAULT_ARGS = ["app-server", "--listen", "stdio://"];
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_INFO = Object.freeze({
  name: "artagon-codex-streaming",
  title: "Artagon Codex Streaming Runner",
  version: "0.1.0"
});

/**
 * @typedef {import("./types.mjs").StreamingRunner} StreamingRunner
 * @typedef {import("./types.mjs").StreamingHealth} StreamingHealth
 * @typedef {import("./types.mjs").StreamingTurnOptions} StreamingTurnOptions
 * @typedef {import("./types.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/translate/stream-runner.mjs").SessionUpdate} SessionUpdate
 *
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   command?: string,
 *   args?: string[],
 *   model?: string,
 *   createTransport?: typeof createCliTransport,
 *   createClient?: typeof createAcpClient
 * }} CreateCodexStreamingOptions
 */

/**
 * Construct a codex streaming runner. The runner is NOT started here —
 * the supervisor calls `start()` lazily on the first turn. Returns a
 * fresh runner each time; do not share across supervisors.
 *
 * Transport / client constructors are injectable for testing; production
 * callers omit them.
 *
 * @param {CreateCodexStreamingOptions} [options]
 * @returns {StreamingRunner}
 */
export function createCodexStreamingRunner(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const command = options.command ?? DEFAULT_COMMAND;
  const args = options.args ?? DEFAULT_ARGS;
  const defaultModel = options.model;
  const transportFactory = options.createTransport ?? createCliTransport;
  const clientFactory = options.createClient ?? createAcpClient;

  /** @type {ReturnType<typeof createCliTransport> | null} */
  let transport = null;
  /** @type {ReturnType<typeof createAcpClient> | null} */
  let client = null;
  /** @type {(() => void) | null} */
  let unsubscribeNotifications = null;
  /** @type {string | null} */
  let threadId = null;
  /** @type {StreamingHealth} */
  let health = "starting";
  let started = false;

  /** @type {TurnResult | null} */
  let activeTurn = null;
  /** @type {((u: SessionUpdate) => void) | null} */
  let activeOnUpdate = null;
  /** @type {{ resolve: () => void, reject: (e: Error) => void } | null} */
  let activeCompletion = null;

  /**
   * Translate one codex app-server notification into zero-or-more
   * SessionUpdates, push each into the active turn, and finalize on
   * `turn/completed`.
   *
   * @param {import("#lib/acp/types.mjs").JsonRpcNotification} notification
   */
  function handleNotification(notification) {
    if (!notification || typeof notification !== "object") return;
    if (!activeTurn) return;
    const method = notification.method;
    const params = /** @type {any} */ (notification.params) ?? {};

    switch (method) {
      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!delta) return;
        activeTurn.text += delta;
        activeTurn.chunkCount += 1;
        activeTurn.chunkChars += delta.length;
        emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { text: delta }
        });
        return;
      }
      case "item/started": {
        const item = params.item;
        if (!item || typeof item !== "object") return;
        // Tool-like items: anything with an explicit command, function,
        // or non-text type. Plain agentMessage items are tracked by the
        // delta accumulator above, not as tool calls.
        if (item.type === "agentMessage") return;
        const toolName = typeof item.type === "string" ? item.type : "unknown";
        const toolUseId = typeof item.id === "string" ? item.id : String(item.id ?? "");
        if (!toolUseId) return;
        const argsPayload = extractToolArgs(item);
        activeTurn.toolCalls.push({ toolName, toolUseId, args: argsPayload });
        emitUpdate({
          sessionUpdate: "tool_call",
          toolName,
          toolUseId,
          args: argsPayload
        });
        return;
      }
      case "item/completed": {
        const item = params.item;
        if (!item || typeof item !== "object") return;
        if (item.type === "agentMessage") return;
        const toolUseId = typeof item.id === "string" ? item.id : String(item.id ?? "");
        if (!toolUseId) return;
        const isError =
          item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
        const result = extractToolResult(item);
        activeTurn.toolResults.push({ toolUseId, result, isError });
        emitUpdate({
          sessionUpdate: "tool_result",
          toolUseId,
          result,
          isError
        });
        return;
      }
      case "turn/completed": {
        const turn = params.turn ?? {};
        if (!activeTurn.reason && typeof turn.status === "string") {
          activeTurn.reason = turn.status;
        }
        if (!activeTurn.usage && turn.tokenUsage) {
          activeTurn.usage = turn.tokenUsage;
        }
        emitUpdate({
          sessionUpdate: "turn_completed",
          reason: activeTurn.reason ?? undefined,
          usage: activeTurn.usage ?? undefined,
          model: activeTurn.model ?? undefined
        });
        // Settle the runTurn waiter. Notification arrival is the
        // terminal signal — turn/start's response only acknowledges
        // acceptance.
        const completion = activeCompletion;
        activeCompletion = null;
        completion?.resolve();
        return;
      }
      case "thread/tokenUsage/updated": {
        if (params.usage) activeTurn.usage = params.usage;
        return;
      }
      default:
        return;
    }
  }

  /** @param {SessionUpdate} update */
  function emitUpdate(update) {
    if (!activeTurn) return;
    activeTurn.updates.push(update);
    if (activeOnUpdate) {
      try {
        activeOnUpdate(update);
      } catch {
        // caller bug; best-effort
      }
    }
  }

  return {
    async start() {
      if (started) return;
      transport = transportFactory({
        command,
        args,
        env,
        cwd
      });
      client = clientFactory(/** @type {any} */ (transport));
      unsubscribeNotifications = client.onNotification(handleNotification);
      try {
        await transport.start();
        await client.request("initialize", {
          clientInfo: CLIENT_INFO
        });
        client.notify("initialized", {});
        /** @type {any} */
        const threadResponse = await client.request("thread/start", {
          cwd,
          ...(defaultModel ? { model: resolveCodexModel(defaultModel) } : {})
        });
        threadId = threadResponse?.thread?.id ?? null;
        if (!threadId) {
          throw new Error("createCodexStreamingRunner: thread/start returned no thread id");
        }
        started = true;
        health = "healthy";
      } catch (err) {
        health = "dead";
        await safeCloseTransport();
        throw err;
      }
    },

    async runTurn(turnOpts) {
      if (!started || !client) {
        throw new Error("codex streaming runner: runTurn before start");
      }
      const startedAtMs = Date.now();
      const timeoutMs = turnOpts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

      /** @type {TurnResult} */
      const turn = {
        text: "",
        thoughtText: "",
        chunkCount: 0,
        chunkChars: 0,
        thoughtCount: 0,
        thoughtChars: 0,
        toolCalls: [],
        toolResults: [],
        usage: null,
        reason: null,
        model: turnOpts.model ?? defaultModel ?? null,
        updates: []
      };
      activeTurn = turn;
      activeOnUpdate = turnOpts.onUpdate ?? null;

      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      /** @type {Promise<void>} */
      const completion = new Promise((resolve, reject) => {
        activeCompletion = { resolve, reject };
      });

      try {
        const timeoutPromise = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`codex streaming runner: turn timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const work = (async () => {
          /** @type {any} */
          const startResp = await /** @type {any} */ (client).request("turn/start", {
            threadId,
            userInput: turnOpts.prompt,
            ...(turnOpts.model ? { model: resolveCodexModel(turnOpts.model) } : {})
          });
          // turn/start response is acknowledgment only; terminal signal
          // arrives via turn/completed notification.
          if (!turn.model && startResp?.turn?.model) {
            turn.model = String(startResp.turn.model);
          }
          await completion;
        })();

        await Promise.race([work, timeoutPromise]);
        health = "healthy";
        appendCostRecord({
          backend: BACKEND_NAMES.CODEX,
          model: turn.model ?? null,
          promptChars: turnOpts.prompt.length,
          usage: normalizeUsage(turn.usage ?? null),
          durationMs: Date.now() - startedAtMs,
          reason: turn.reason ?? null,
          ok: true,
          transport: "codex-app-server"
        });
        return turn;
      } catch (err) {
        const isOpen = transport ? transport.isOpen() : false;
        health = isOpen ? "degraded" : "dead";
        appendCostRecord({
          backend: BACKEND_NAMES.CODEX,
          model: turn.model ?? null,
          promptChars: turnOpts.prompt.length,
          usage: normalizeUsage(turn.usage ?? null),
          durationMs: Date.now() - startedAtMs,
          reason: turn.reason ?? null,
          ok: false,
          transport: "codex-app-server"
        });
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        activeTurn = null;
        activeOnUpdate = null;
        if (activeCompletion) {
          // turn settled by error / timeout — abandon the waiter
          activeCompletion = null;
        }
      }
    },

    async close() {
      started = false;
      health = "dead";
      threadId = null;
      if (unsubscribeNotifications) {
        try {
          unsubscribeNotifications();
        } catch {
          // best-effort
        }
        unsubscribeNotifications = null;
      }
      if (client) {
        try {
          await client.close();
        } catch {
          // best-effort
        }
        client = null;
      }
      await safeCloseTransport();
    },

    health() {
      return health;
    }
  };

  async function safeCloseTransport() {
    if (transport) {
      try {
        await transport.close();
      } catch {
        // best-effort
      }
      transport = null;
    }
  }
}

/**
 * Best-effort extraction of the tool-call argument payload from a
 * codex `item/started` item.
 *
 * @param {any} item
 * @returns {any}
 */
function extractToolArgs(item) {
  if (item.command !== undefined) return { command: item.command, cwd: item.cwd };
  if (item.arguments !== undefined) return item.arguments;
  if (item.input !== undefined) return item.input;
  return {};
}

/**
 * Best-effort extraction of the tool-result payload from a codex
 * `item/completed` item.
 *
 * @param {any} item
 * @returns {any}
 */
function extractToolResult(item) {
  if (item.output !== undefined || item.exitCode !== undefined) {
    return { output: item.output ?? null, exitCode: item.exitCode ?? null };
  }
  if (item.result !== undefined) return item.result;
  return null;
}
