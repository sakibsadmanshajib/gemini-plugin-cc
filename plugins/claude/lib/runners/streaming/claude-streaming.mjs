/**
 * Claude streaming runner — keeps one `claude-agent-acp` subprocess
 * open across many turns and drives it over standard Zed ACP.
 *
 * Backed by `@agentclientprotocol/claude-agent-acp` (Apache-2.0,
 * maintained by Zed Industries), which exposes Claude via the
 * Agent Client Protocol on stdio. The runner is shaped like
 * `gemini-streaming.mjs` because both speak the same wire format
 * (`session/new` / `session/prompt` / `session/update` with
 * `agent_message_chunk`-style notifications) — the only difference
 * is that claude-agent-acp is spawned directly as a child here
 * (no external broker daemon), the way `codex-streaming.mjs` owns
 * `codex app-server`.
 *
 * Auth model:
 *   claude-agent-acp authenticates via either:
 *     - the user's existing `claude login` (Claude Pro/Max OAuth);
 *     - `ANTHROPIC_API_KEY` env var (Anthropic Console billing); or
 *     - a custom gateway when the client advertises that capability.
 *   The runner doesn't drive `authenticate` itself — it relies on
 *   whichever credentials are already available on the host. If
 *   none are present, `session/new` errors out with an actionable
 *   message that bubbles up through the dispatch fallback.
 *
 * Sequence in start():
 *   spawn `node <claude-agent-acp>/dist/index.js`     (via createCliTransport)
 *     → initialize (request)
 *     → session/new (request)                           ← stores sessionId
 *
 * Sequence in runTurn():
 *   session/prompt (request)                            ← awaits to completion
 *   while pending, session/update notifications stream
 *     → agent_message_chunk          → text accum
 *     → agent_thought_chunk          → thoughtText accum
 *     → tool_call / tool_result      → push to toolCalls / toolResults
 *     → usage_update                 → usage accum (last-write-wins)
 *     → turn_completed (if emitted)  → reason + usage
 *   session/prompt response carries terminal stopReason + usage.
 *
 * Why not a fresh client per turn:
 *   The whole point of streaming is amortising the initialize +
 *   session/new round trip across turns. The supervisor's idle reap
 *   bounds the lifetime when the user goes idle.
 */

import { createRequire } from "node:module";

import { resolveClaudeModel } from "#lib/backends/claude.mjs";
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { TRANSPORT_NAMES } from "#lib/cost/transport-names.mjs";
import { createCliTransport } from "#lib/transport/cli.mjs";
import { openWireLog } from "#lib/wire-log.mjs";

import { createAcpClient } from "../../acp/client.mjs";

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_CAPABILITIES = Object.freeze({
  // Decline terminal-auth advertisement — we don't run interactive
  // login flows from the streaming runner; the user must authenticate
  // out of band (claude login or ANTHROPIC_API_KEY).
  auth: { terminal: false },
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
 *   protocolVersion?: number,
 *   model?: string,
 *   context?: import("#lib/agent-context.mjs").AgentContext,
 *   createTransport?: typeof createCliTransport,
 *   createClient?: typeof createAcpClient,
 *   resolveEntry?: () => string
 * }} CreateClaudeStreamingOptions
 */

/**
 * Resolve the path to the bundled claude-agent-acp entry script. Kept
 * lazy (and overrideable in tests) so the package's absence in dev
 * snapshots doesn't break unrelated imports.
 *
 * @returns {string}
 */
function defaultResolveEntry() {
  const require = createRequire(import.meta.url);
  return require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
}

/**
 * Construct a claude streaming runner. The runner is NOT started here
 * — the supervisor calls `start()` lazily on the first turn. Returns
 * a fresh runner each time; do not share across supervisors.
 *
 * @param {CreateClaudeStreamingOptions} [options]
 * @returns {StreamingRunner}
 */
export function createClaudeStreamingRunner(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  // Wire-log binding is captured at construction; supervisor reuses
  // the runner across turns. `--wire-log` on later turns won't rebind.
  const factoryLogging = options.context?.logging;
  const transportFactory = options.createTransport ?? createCliTransport;
  const clientFactory = options.createClient ?? createAcpClient;
  const resolveEntry = options.resolveEntry ?? defaultResolveEntry;
  const defaultModel = options.model;
  const command = options.command ?? process.execPath;
  const args = options.args; // resolved lazily so an overridden resolveEntry takes effect

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

  /** @type {TurnResult | null} */
  let activeTurn = null;
  /** @type {((u: SessionUpdate) => void) | null} */
  let activeOnUpdate = null;

  /** @param {import("#lib/acp/types.mjs").JsonRpcNotification} notification */
  function handleNotification(notification) {
    if (!notification || notification.method !== "session/update") return;
    if (!activeTurn) return;
    const params = /** @type {any} */ (notification.params) ?? {};
    const update = params.update;
    if (!update || typeof update.sessionUpdate !== "string") return;
    applySessionUpdate(/** @type {SessionUpdate} */ (update));
  }

  /** @param {SessionUpdate} update */
  function applySessionUpdate(update) {
    if (!activeTurn) return;
    activeTurn.updates.push(update);
    if (activeOnUpdate) {
      try {
        activeOnUpdate(update);
      } catch {
        // caller bug; best-effort
      }
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.text ?? "";
        activeTurn.text += text;
        activeTurn.chunkCount += 1;
        activeTurn.chunkChars += text.length;
        break;
      }
      case "agent_thought_chunk": {
        const text = update.content?.text ?? "";
        activeTurn.thoughtText += text;
        activeTurn.thoughtCount += 1;
        activeTurn.thoughtChars += text.length;
        break;
      }
      case "tool_call":
        if (update.toolName && update.toolUseId !== undefined) {
          activeTurn.toolCalls.push({
            toolName: update.toolName,
            toolUseId: String(update.toolUseId),
            args: update.args ?? {},
          });
        }
        break;
      case "tool_result":
        if (update.toolUseId !== undefined) {
          activeTurn.toolResults.push({
            toolUseId: String(update.toolUseId),
            result: update.result ?? null,
            isError: Boolean(update.isError),
          });
        }
        break;
      case "usage_update":
        if (update.usage) activeTurn.usage = update.usage;
        break;
      case "turn_completed":
        if (update.reason && !activeTurn.reason)
          activeTurn.reason = update.reason;
        if (update.usage && !activeTurn.usage) activeTurn.usage = update.usage;
        if (update.model && !activeTurn.model) activeTurn.model = update.model;
        break;
      default:
        break;
    }
  }

  return {
    async start() {
      if (started) return;
      const resolvedArgs = args ?? [resolveEntry()];
      transport = transportFactory({
        command,
        args: resolvedArgs,
        env,
        cwd,
        wireLog: openWireLog(factoryLogging),
      });
      client = clientFactory(/** @type {any} */ (transport));
      unsubscribeNotifications = client.onNotification(handleNotification);
      try {
        await transport.start();
        await client.request("initialize", {
          protocolVersion,
          clientCapabilities: CLIENT_CAPABILITIES,
        });
        /** @type {any} */
        const sessionResponse = await client.request("session/new", {
          cwd,
          mcpServers: [],
        });
        sessionId = sessionResponse?.sessionId ?? null;
        if (!sessionId) {
          throw new Error(
            "createClaudeStreamingRunner: session/new returned no sessionId",
          );
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
        throw new Error("claude streaming runner: runTurn before start");
      }
      const startedAtMs = Date.now();
      const timeoutMs = turnOpts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const modelForTurn = turnOpts.model ?? defaultModel ?? null;

      // Register the active-turn accumulator BEFORE any await so any
      // notification arriving mid-policy (session/load) is captured.
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
        model: modelForTurn ? resolveClaudeModel(modelForTurn) : null,
        sessionId,
        updates: [],
      };
      activeTurn = turn;
      activeOnUpdate = turnOpts.onUpdate ?? null;

      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      // F9: hoisted so the finally block can detach the abort listener.
      const signal = turnOpts.signal;
      /** @type {(() => void) | null} */
      let onAbort = null;
      try {
        // Apply per-turn session intent INSIDE the try (F1). Tagged-
        // union switch (F6): exactly one of reuse/fresh/resume.
        // H3: per-turn cwd flows here. Order: turnOpts.cwd > context.cwd
        // > factory-default. Lets a daemon serve many workspaces over
        // one cached supervisor.
        const turnCwd = turnOpts.cwd ?? context?.cwd ?? cwd;
        switch (context?.session?.action ?? "reuse") {
          case "fresh": {
            /** @type {any} */
            const fresh = await /** @type {any} */ (client).request(
              "session/new",
              {
                cwd: turnCwd,
                mcpServers: [],
              },
            );
            const freshId = fresh?.sessionId;
            if (!freshId) {
              throw new Error(
                "claude streaming runner: session/new returned no sessionId",
              );
            }
            sessionId = freshId;
            turn.sessionId = freshId;
            break;
          }
          case "resume": {
            const resumeId = /** @type {{ action: "resume", id: string }} */ (
              /** @type {any} */ (context.session)
            ).id;
            await /** @type {any} */ (client).request("session/load", {
              sessionId: resumeId,
              cwd: turnCwd,
              mcpServers: [],
            });
            sessionId = resumeId;
            turn.sessionId = resumeId;
            break;
          }
          default:
            break;
        }

        // F9: bridge AbortSignal → session/cancel. Best-effort; the
        // local race-promise still rejects when signal aborts.
        if (signal) {
          onAbort = () => {
            try {
              /** @type {any} */ (client).notify("session/cancel", {
                sessionId,
              });
            } catch {
              // best-effort
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const timeoutPromise = new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `claude streaming runner: turn timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });
        const work = (async () => {
          /** @type {any} */
          const response = await /** @type {any} */ (client).request(
            "session/prompt",
            {
              sessionId,
              prompt: [{ type: "text", text: turnOpts.prompt }],
            },
          );
          if (response?.stopReason && !turn.reason) {
            turn.reason = String(response.stopReason);
          }
          if (response?.usage && !turn.usage) {
            turn.usage = response.usage;
          }
        })();
        await Promise.race([work, timeoutPromise]);
        health = "healthy";
        appendCostRecord(
          {
            backend: BACKEND_NAMES.CLAUDE,
            model: turn.model ?? null,
            promptChars: turnOpts.prompt.length,
            usage: normalizeUsage(turn.usage ?? null),
            durationMs: Date.now() - startedAtMs,
            reason: turn.reason ?? null,
            ok: true,
            transport: TRANSPORT_NAMES.CLAUDE_AGENT_ACP,
          },
          { context },
        );
        return turn;
      } catch (err) {
        const isOpen = transport ? transport.isOpen() : false;
        health = isOpen ? "degraded" : "dead";
        appendCostRecord(
          {
            backend: BACKEND_NAMES.CLAUDE,
            model: turn.model ?? null,
            promptChars: turnOpts.prompt.length,
            usage: normalizeUsage(turn.usage ?? null),
            durationMs: Date.now() - startedAtMs,
            reason: turn.reason ?? null,
            ok: false,
            transport: TRANSPORT_NAMES.CLAUDE_AGENT_ACP,
          },
          { context },
        );
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
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
          // best-effort
        }
        client = null;
      }
      await safeCloseTransport();
    },

    health() {
      return health;
    },
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
