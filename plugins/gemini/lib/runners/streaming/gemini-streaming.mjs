/**
 * Gemini streaming runner — spawns `gemini --acp` as a child subprocess
 * and keeps one ACP connection open across many turns over stdio. The
 * runner OWNS the subprocess; lifetime is bounded by start()/close().
 *
 * Step 2 of the unified-facade plan replaced the previous broker-socket
 * dependency with direct subprocess ownership. This makes the gemini
 * runner symmetric with codex/claude — all three streaming runners now
 * spawn their CLI directly via `lib/transport/cli.mjs::createCliTransport`.
 *
 * **Error-message contract (round-16 lock-in).** This file's `throw new
 * Error("…")` strings are part of a test contract — the byte-exact
 * strings appear in `tests/unit/streaming-registry.test.mjs` so the
 * `classifyLastError` redaction stays correct against the actual runner
 * shapes. Rewording any of these messages will fail a specific lock-in
 * test pointing at the affected line; if you intentionally reword one,
 * update the matching test case in lockstep:
 *   - "broker returned no sessionId"           → session_init_failed
 *   - "session/new returned no sessionId"      → session_init_failed
 *   - "runTurn before start"                   → internal_error
 *   - "turn timed out after Xms"               → timeout
 *
 * Lifecycle:
 *   start()    → spawn gemini --acp → initialize → session/new → ready
 *   runTurn()  → (apply session policy) → session/prompt → accumulate
 *                session/update notifications → return TurnResult
 *   close()    → close transport (kills the subprocess)
 *
 * Health labels:
 *   "starting"   pre-start or start in flight
 *   "healthy"    last turn succeeded; transport is open
 *   "degraded"   last turn errored but transport is still open; caller
 *                may retry without restart
 *   "dead"       transport closed (subprocess died, idle reap); the
 *                supervisor calls start() again to recover
 */

import { resolveGeminiModel } from "#lib/backends/gemini.mjs";
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { TRANSPORT_NAMES } from "#lib/cost/transport-names.mjs";
import { translateGeminiStreamEvent } from "#lib/translate/gemini-stream.mjs";
import { createCliTransport } from "#lib/transport/cli.mjs";
import { openWireLog } from "#lib/wire-log.mjs";

import { createAcpClient } from "../../acp/client.mjs";

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND = "gemini";
const DEFAULT_ARGS = ["--acp"];

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
 *   command?: string,
 *   args?: string[],
 *   protocolVersion?: number,
 *   model?: string,
 *   context?: import("#lib/agent-context.mjs").AgentContext,
 *   createTransport?: typeof createCliTransport,
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
  const env = options.env ?? process.env;
  const command = options.command ?? DEFAULT_COMMAND;
  const args = options.args ?? DEFAULT_ARGS;
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  // Wire-log binding is captured at construction; supervisor reuses
  // the runner across turns. `--wire-log` on later turns won't rebind.
  const factoryLogging = options.context?.logging;
  const transportFactory = options.createTransport ?? createCliTransport;
  const clientFactory = options.createClient ?? createAcpClient;

  /** @type {ReturnType<typeof createCliTransport> | null} */
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
  // Last canonical model id successfully applied via `session/set_model`.
  // Tracked so per-turn model overrides skip the round-trip when the
  // requested model already matches, and so a fresh/resumed session
  // resets to null (new session = no model applied yet). Matches the
  // pattern used by claude-streaming.mjs.
  /** @type {string | null} */
  let appliedModel = null;

  /**
   * Apply `targetAlias` to the current session via `session/set_model`.
   * The gemini agent advertises a `models.availableModels` catalog on
   * session/new (verified 2026-05-12: `auto-gemini-3`, `auto-gemini-2.5`,
   * `gemini-3.1-pro-preview`, `gemini-3-flash-preview`,
   * `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`,
   * `gemini-2.5-flash-lite`). resolveGeminiModel collapses our aliases
   * onto those agent IDs.
   *
   * Throws on agent error — the caller decides whether to fail the
   * whole turn (we do, same as claude).
   *
   * @param {string | null | undefined} targetAlias
   */
  async function applySessionModel(targetAlias) {
    if (!targetAlias) return;
    if (!client || !sessionId) return;
    const resolved = resolveGeminiModel(targetAlias);
    if (resolved === appliedModel) return;
    await /** @type {any} */ (client).request("session/set_model", {
      sessionId,
      modelId: resolved
    });
    appliedModel = resolved;
  }

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
      transport = transportFactory({
        command,
        args,
        env,
        cwd,
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
        // Apply the runner's default model to the new session if one
        // was passed at construction time. Failures surface as start()
        // errors so the operator sees "unknown model" rather than the
        // request silently falling back.
        await applySessionModel(options.model);
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

      // Register the active-turn accumulator BEFORE any await so any
      // notification that arrives mid-request (e.g. during session/load)
      // is captured. We update turn.sessionId after the session-policy
      // block resolves below.
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
        sessionId,
        updates: []
      };
      activeTurn = turn;
      activeOnUpdate = turnOpts.onUpdate ?? null;

      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      // F9: hoisted so the finally block can detach the abort listener.
      const signal = turnOpts.signal;
      /** @type {(() => void) | null} */
      let onAbort = null;
      /** @type {(() => void) | null} */
      let onAbortReject = null;
      try {
        // F9 (race fix): install signal-abort handler BEFORE any setup
        // await (session/new, session/load, set_model). Without this,
        // an abort during pre-prompt setup would silently drop on the
        // floor — no session/cancel notify and no early throw. Handler
        // reads `sessionId` lazily via closure so fresh/resume paths
        // still notify the correct id.
        if (signal) {
          if (signal.aborted) {
            throw signal.reason ?? new Error("aborted");
          }
          onAbort = () => {
            try {
              /** @type {any} */ (client).notify("session/cancel", {
                sessionId
              });
            } catch {
              // best-effort — transport may be closed
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Apply per-turn session intent BEFORE the prompt. Inside the
        // try so a failure here marks supervisor health, writes a cost
        // record with ok:false, and clears activeTurn in the finally.
        // SessionPolicy is a tagged union (F6) — exhaustive switch.
        // H3: per-turn cwd flows here. turnOpts.cwd > context.cwd >
        // factory-default. Lets the daemon serve many workspaces over
        // one cached supervisor.
        const turnCwd = turnOpts.cwd ?? context?.cwd ?? cwd;
        switch (context?.session?.action ?? "reuse") {
          case "fresh": {
            /** @type {any} */
            const fresh = await /** @type {any} */ (client).request("session/new", {
              cwd: turnCwd,
              mcpServers: []
            });
            const freshId = fresh?.sessionId;
            if (!freshId) {
              throw new Error("gemini streaming runner: session/new returned no sessionId");
            }
            sessionId = freshId;
            turn.sessionId = freshId;
            // New session — no model applied yet; force re-apply below.
            appliedModel = null;
            break;
          }
          case "resume": {
            const resumeId = /** @type {{ action: "resume", id: string }} */ (
              /** @type {any} */ (context.session)
            ).id;
            await /** @type {any} */ (client).request("session/load", {
              sessionId: resumeId,
              cwd: turnCwd,
              mcpServers: []
            });
            sessionId = resumeId;
            turn.sessionId = resumeId;
            // Resumed session: model selection is whatever the prior
            // owner left; force a reapply for a well-defined state.
            appliedModel = null;
            break;
          }
          default:
            // no-op — keep stored sessionId
            break;
        }

        // Apply per-turn model override (turnOpts.model) on top of any
        // factory default. Skips the round-trip when the requested
        // model already matches what's applied. set_model failure
        // aborts the turn — no silent fallback.
        await applySessionModel(turnOpts.model);

        // F9 (race fix): abort during session/prompt must unwedge the
        // work promise locally, in addition to the session/cancel notify
        // already wired at the top of the try. Without this racer, the
        // runner would block on the request/response cycle until the
        // agent honored the cancel.
        const abortPromise = signal
          ? new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason ?? new Error("aborted"));
                return;
              }
              onAbortReject = () => reject(signal.reason ?? new Error("aborted"));
              signal.addEventListener("abort", onAbortReject, { once: true });
            })
          : null;

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
        const racers = /** @type {Promise<any>[]} */ ([work, timeoutPromise]);
        if (abortPromise) racers.push(abortPromise);
        await Promise.race(racers);
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
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        if (signal && onAbortReject) {
          signal.removeEventListener("abort", onAbortReject);
        }
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
