/**
 * Gemini streaming runner — keeps one ACP connection open across many
 * turns, using the existing `gemini --acp` broker as the upstream.
 *
 * Compared to `runGeminiViaBroker` which connects-runs-disconnects per
 * turn, this runner connects ONCE in `start()` and reuses the same
 * session for every `runTurn()` call. That removes the per-turn
 * connect+initialize+session/new round-trip (~50-150ms each) and keeps
 * any model-side warmup state alive between turns.
 *
 * Lifecycle:
 *   start()    → probe for live broker → connect → initialize →
 *                session/new → ready
 *   runTurn()  → session/prompt → accumulate session/update notifications
 *                → return TurnResult
 *   close()    → close transport (broker stays alive for other clients)
 *
 * Health labels:
 *   "starting"   pre-start or start in flight
 *   "healthy"    last turn succeeded; transport is open
 *   "degraded"   last turn errored but transport is still open; caller
 *                may retry without restart
 *   "dead"       transport closed (broker died, network, idle reap);
 *                supervisor must call start() again to recover
 *
 * Why this depends on a running broker (not its own subprocess):
 *   - The legacy gemini broker is the canonical owner of `gemini --acp`
 *     subprocesses. Lifting that ownership into shared lib is a
 *     separate, larger task (Phase 1 of unified-acp-server).
 *   - For the Phase-3 quick win (this file), reusing the broker is
 *     enough: most users will have a broker running for slash commands
 *     anyway, and when they don't, the dispatcher falls back to
 *     cold-start cleanly.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { TRANSPORT_NAMES } from "#lib/cost/transport-names.mjs";
import { translateGeminiStreamEvent } from "#lib/translate/gemini-stream.mjs";
import { findActiveBroker } from "#lib/transport/broker-probe.mjs";
import { createBrokerSocketTransport } from "#lib/transport/broker-socket.mjs";
import { openWireLog } from "#lib/wire-log.mjs";

import { createAcpClient } from "../../acp/client.mjs";

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {import("./types.mjs").StreamingRunner} StreamingRunner
 * @typedef {import("./types.mjs").StreamingHealth} StreamingHealth
 * @typedef {import("./types.mjs").StreamingTurnOptions} StreamingTurnOptions
 * @typedef {import("./types.mjs").TurnResult} TurnResult
 */

/**
 * Options for the gemini streaming runner factory.
 *
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   protocolVersion?: number,
 *   context?: import("#lib/agent-context.mjs").AgentContext,
 *   probe?: typeof findActiveBroker,
 *   createTransport?: typeof createBrokerSocketTransport,
 *   createClient?: typeof createAcpClient
 * }} CreateGeminiStreamingOptions
 */

/**
 * Construct a gemini streaming runner. The runner is NOT started here —
 * the supervisor calls `start()` lazily on the first turn. Returns a
 * fresh runner each time; do not share across supervisors.
 *
 * Probe / transport / client constructors are injectable for testing
 * (the unit tests pass mocks); production callers omit them.
 *
 * @param {CreateGeminiStreamingOptions} [options]
 * @returns {StreamingRunner}
 */
export function createGeminiStreamingRunner(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  // Wire-log binding is captured at construction; supervisor reuses
  // the runner across turns. `--wire-log` on later turns won't rebind.
  const factoryLogging = options.context?.logging;
  const probe = options.probe ?? findActiveBroker;
  const transportFactory = options.createTransport ?? createBrokerSocketTransport;
  const clientFactory = options.createClient ?? createAcpClient;

  /** @type {ReturnType<typeof createBrokerSocketTransport> | null} */
  let transport = null;
  /** @type {ReturnType<typeof createAcpClient> | null} */
  let client = null;
  /** @type {(() => void) | null} */
  let unsubscribeNotifications = null;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {StreamingHealth} */
  let health = "starting";
  let started = false;

  /**
   * The accumulator the per-turn notification handler writes into.
   * Reassigned at the top of each runTurn; null between turns.
   *
   * @type {TurnResult | null}
   */
  let activeTurn = null;
  /** @type {((u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void) | null} */
  let activeOnUpdate = null;

  /** @param {import("#lib/acp/types.mjs").JsonRpcNotification} notification */
  function handleNotification(notification) {
    if (!notification || notification.method !== "session/update") return;
    if (!activeTurn) return;
    const params = notification.params;
    if (!params || !params.update) return;
    const sessionUpdate = translateGeminiStreamEvent(params.update);
    if (!sessionUpdate) return;
    const updates = Array.isArray(sessionUpdate) ? sessionUpdate : [sessionUpdate];
    for (const u of updates) {
      activeTurn.updates.push(u);
      if (activeOnUpdate) {
        try {
          activeOnUpdate(u);
        } catch {
          // best-effort; caller bug
        }
      }
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const text = u.content?.text ?? "";
          activeTurn.text += text;
          activeTurn.chunkCount += 1;
          activeTurn.chunkChars += text.length;
          break;
        }
        case "agent_thought_chunk": {
          const text = u.content?.text ?? "";
          activeTurn.thoughtText += text;
          activeTurn.thoughtCount += 1;
          activeTurn.thoughtChars += text.length;
          break;
        }
        case "tool_call":
          if (u.toolName && u.toolUseId !== undefined) {
            activeTurn.toolCalls.push({
              toolName: u.toolName,
              toolUseId: u.toolUseId,
              args: u.args ?? {}
            });
          }
          break;
        case "tool_result":
          if (u.toolUseId !== undefined) {
            activeTurn.toolResults.push({
              toolUseId: u.toolUseId,
              result: u.result ?? null,
              isError: Boolean(u.isError)
            });
          }
          break;
        case "turn_completed":
          if (u.reason && !activeTurn.reason) activeTurn.reason = u.reason;
          if (u.usage && !activeTurn.usage) activeTurn.usage = u.usage;
          if (u.model && !activeTurn.model) activeTurn.model = u.model;
          break;
        default:
          break;
      }
    }
  }

  return {
    async start() {
      if (started) return;
      const endpoint = probe(cwd, options.env);
      if (!endpoint) {
        health = "dead";
        throw new Error(
          "createGeminiStreamingRunner: no live broker for cwd; start `gemini --acp` first"
        );
      }
      transport = transportFactory({
        endpoint,
        wireLog: openWireLog(factoryLogging)
      });
      client = clientFactory(/** @type {any} */ (transport));
      unsubscribeNotifications = client.onNotification(handleNotification);
      try {
        await transport.start();
        await client.request("initialize", {
          protocolVersion,
          clientCapabilities: {}
        });
        const session = await client.request("session/new", {
          cwd,
          mcpServers: []
        });
        sessionId = /** @type {any} */ (session)?.sessionId ?? null;
        if (!sessionId) {
          throw new Error("createGeminiStreamingRunner: broker returned no sessionId");
        }
        started = true;
        health = "healthy";
      } catch (err) {
        health = "dead";
        await safeCloseTransport();
        throw err;
      }
    },

    async runTurn(turnOpts, context) {
      if (!started || !client) {
        throw new Error("gemini streaming runner: runTurn before start");
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
        model: null,
        updates: []
      };
      activeTurn = turn;
      activeOnUpdate = turnOpts.onUpdate ?? null;

      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      try {
        const timeoutPromise = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`gemini streaming runner: turn timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        const work = (async () => {
          const response = await /** @type {any} */ (client).request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: turnOpts.prompt }]
          });
          const r = /** @type {any} */ (response);
          if (r?.stopReason && !turn.reason) turn.reason = String(r.stopReason);
          // Gemini CLI 0.38+ puts per-turn usage in `_meta.quota.token_count`
          // (real wire frame captured against gemini --acp:
          //   {"stopReason":"end_turn","_meta":{"quota":{
          //     "token_count":{"input_tokens":...,"output_tokens":...},
          //     "model_usage":[{"model":"gemini-...","token_count":{...}}]
          //   }}})
          // rather than the standard top-level `usage` field most ACP
          // agents use. We read _meta first; top-level `usage` is kept
          // as forward-compat for any future spec alignment.
          const metaQuota = r?._meta?.quota;
          if (!turn.usage && metaQuota?.token_count) {
            turn.usage = metaQuota.token_count;
          }
          if (!turn.usage && r?.usage) turn.usage = r.usage;
          // Pick the actual model id from _meta.quota.model_usage when
          // present so cost records reflect the model gemini chose at
          // dispatch time (auto-* aliases resolve here).
          if (
            !turn.model &&
            Array.isArray(metaQuota?.model_usage) &&
            metaQuota.model_usage[0]?.model
          ) {
            turn.model = String(metaQuota.model_usage[0].model);
          }
        })();
        await Promise.race([work, timeoutPromise]);
        health = "healthy";
        appendCostRecord(
          {
            backend: BACKEND_NAMES.GEMINI,
            model: turn.model ?? null,
            promptChars: turnOpts.prompt.length,
            usage: normalizeUsage(turn.usage ?? null),
            durationMs: Date.now() - startedAtMs,
            reason: turn.reason ?? null,
            ok: true,
            transport: TRANSPORT_NAMES.ACP_SERVER
          },
          { context }
        );
        return turn;
      } catch (err) {
        // If the underlying transport is gone, mark dead so the supervisor
        // restarts. Otherwise it's a degraded turn — transport still open,
        // caller can retry without restart.
        const isOpen = transport ? transport.isOpen() : false;
        health = isOpen ? "degraded" : "dead";
        appendCostRecord(
          {
            backend: BACKEND_NAMES.GEMINI,
            model: turn.model ?? null,
            promptChars: turnOpts.prompt.length,
            usage: normalizeUsage(turn.usage ?? null),
            durationMs: Date.now() - startedAtMs,
            reason: turn.reason ?? null,
            ok: false,
            transport: TRANSPORT_NAMES.ACP_SERVER
          },
          { context }
        );
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        activeTurn = null;
        activeOnUpdate = null;
      }
    },

    async close() {
      started = false;
      health = "dead";
      sessionId = null;
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
          // best-effort; transport may have already closed underneath
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
