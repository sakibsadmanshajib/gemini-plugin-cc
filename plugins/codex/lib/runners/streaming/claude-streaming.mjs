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
 * **Error-message contract (round-16 lock-in).** This file's `throw new
 * Error("…")` strings are part of a test contract — the byte-exact
 * strings appear in `tests/unit/streaming-registry.test.mjs` so the
 * `classifyLastError` redaction stays correct against the actual runner
 * shapes. Rewording any of these messages will fail a specific lock-in
 * test pointing at the affected line; if you intentionally reword one,
 * update the matching test case in lockstep:
 *   - "session/new returned no sessionId"   → session_init_failed
 *   - "runTurn before start"                → internal_error
 *   - "turn timed out after Xms"            → timeout
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
  auth: { terminal: false }
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
  // Last canonical model id successfully applied to the current
  // session via `session/set_model`. Tracked so per-turn model
  // overrides can skip the round-trip when the requested model is
  // already in effect, and so a fresh/resumed session resets to null
  // (the new session has no model applied yet).
  /** @type {string | null} */
  let appliedModel = null;
  // Last effort level successfully applied to the current session via
  // `session/set_config_option` (configId="effort"). Same cache /
  // reset semantics as appliedModel — fresh/resumed sessions reset to
  // null so the next turn re-applies.
  /** @type {string | null} */
  let appliedEffort = null;

  /**
   * Apply `targetAlias` to the current session via `session/set_model`
   * (the `unstable_setSessionModel` capability advertised by
   * `@agentclientprotocol/claude-agent-acp` ≥ 0.33). The agent resolves
   * aliases (e.g. `opus[1m]` or `claude-opus-4-7-1m`) to canonical
   * model IDs internally. No-ops when the resolved model matches the
   * last successfully applied one. Throws on agent error — the caller
   * can decide whether to fail the whole turn (we do).
   *
   * @param {string | null | undefined} targetAlias
   */
  async function applySessionModel(targetAlias) {
    if (!targetAlias) return;
    if (!client || !sessionId) return;
    const resolved = resolveClaudeModel(targetAlias);
    if (resolved === appliedModel) return;
    await /** @type {any} */ (client).request("session/set_model", {
      sessionId,
      modelId: resolved
    });
    appliedModel = resolved;
    // claude-agent-acp rebuilds the effort configOption catalog
    // after a model switch (effort levels depend on the selected
    // model — see acp-agent.js's "Rebuild config options" branch).
    // Invalidate our cache so the next applySessionEffort re-issues
    // set_config_option, ensuring the agent's effort matches what
    // the caller asked for.
    appliedEffort = null;
  }

  /**
   * Apply per-turn `effort` to the current session via the standard
   * `session/set_config_option` ACP method (configId="effort"). Claude
   * advertises the available effort levels (`low|medium|high|xhigh|max`)
   * in `session/new` → `result.configOptions[id=effort]`. Skips the
   * round-trip when the requested level matches the last one applied.
   * Throws on agent error so callers see "unknown effort level" rather
   * than the request silently using the wrong budget.
   *
   * @param {string | null | undefined} effort
   */
  async function applySessionEffort(effort) {
    if (!effort) return;
    if (!client || !sessionId) return;
    if (effort === appliedEffort) return;
    await /** @type {any} */ (client).request("session/set_config_option", {
      sessionId,
      configId: "effort",
      value: effort
    });
    appliedEffort = effort;
  }

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
            args: update.args ?? {}
          });
        }
        break;
      case "tool_result":
        if (update.toolUseId !== undefined) {
          activeTurn.toolResults.push({
            toolUseId: String(update.toolUseId),
            result: update.result ?? null,
            isError: Boolean(update.isError)
          });
        }
        break;
      case "usage_update":
        if (update.usage) activeTurn.usage = update.usage;
        break;
      case "turn_completed":
        if (update.reason && !activeTurn.reason) activeTurn.reason = update.reason;
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
        wireLog: openWireLog(factoryLogging)
      });
      client = clientFactory(/** @type {any} */ (transport));
      unsubscribeNotifications = client.onNotification(handleNotification);
      try {
        await transport.start();
        await client.request("initialize", {
          protocolVersion,
          clientCapabilities: CLIENT_CAPABILITIES
        });
        /** @type {any} */
        const sessionResponse = await client.request("session/new", {
          cwd,
          mcpServers: []
        });
        sessionId = sessionResponse?.sessionId ?? null;
        if (!sessionId) {
          throw new Error("createClaudeStreamingRunner: session/new returned no sessionId");
        }
        // Apply the runner's default model to the new session, if one
        // is configured. This is what makes opus-1m / claude-opus-4-7-1m
        // actually flow into the agent rather than relying on the user's
        // claude config. Failures surface as start() errors — the
        // operator needs to see "model not supported" rather than have
        // it silently fall back to the wrong model.
        await applySessionModel(defaultModel);
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
        // await (session/new, session/load, set_model, set_config_option).
        // Without this, an abort during pre-prompt setup would silently
        // drop — no session/cancel notify and no early throw — leaving
        // the agent doing wasted work and the caller blocked on a
        // doomed turn. The handler reads `sessionId` at fire time
        // (closure over outer `let`), so the session-action switch
        // below can change sessionId freely.
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
              // best-effort
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Apply per-turn session intent INSIDE the try (F1). Tagged-
        // union switch (F6): exactly one of reuse/fresh/resume.
        // H3: per-turn cwd flows here. Order: turnOpts.cwd > context.cwd
        // > factory-default. Lets a daemon serve many workspaces over
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
              throw new Error("claude streaming runner: session/new returned no sessionId");
            }
            sessionId = freshId;
            turn.sessionId = freshId;
            // New session has no model/effort applied yet — reset both
            // caches so applySessionModel / applySessionEffort below
            // re-issue the corresponding config requests.
            appliedModel = null;
            appliedEffort = null;
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
            // Resumed session: its server-side model/effort selection
            // is whatever the prior owner left; force a reapply so
            // this session's state is well-defined.
            appliedModel = null;
            appliedEffort = null;
            break;
          }
          default:
            break;
        }

        // Apply per-turn model override (turnOpts.model) on top of the
        // session's default. Skips the round-trip when the requested
        // model already matches what's applied. set_model failure
        // aborts the turn — the operator needs to see "unknown model"
        // rather than have it silently fall back.
        await applySessionModel(modelForTurn);
        // Apply per-turn effort override (turnOpts.effort) via the
        // standard set_config_option ACP method. Claude advertises
        // effort levels in session/new → configOptions[id=effort]:
        // low|medium|high|xhigh|max. Same cache + fail-loud semantics
        // as applySessionModel above.
        await applySessionEffort(turnOpts.effort);

        // F9 (race fix): an abort while session/prompt is in flight
        // must unwedge the work promise locally, in addition to the
        // session/cancel notify already wired above. Without this
        // racer, the runner would block on the request/response cycle
        // until the agent honored the cancel — caller sees AbortError
        // immediately instead.
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
            reject(new Error(`claude streaming runner: turn timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        const work = (async () => {
          /** @type {any} */
          const response = await /** @type {any} */ (client).request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: turnOpts.prompt }]
          });
          if (response?.stopReason && !turn.reason) {
            turn.reason = String(response.stopReason);
          }
          if (response?.usage && !turn.usage) {
            turn.usage = response.usage;
          }
        })();
        const racers = /** @type {Promise<any>[]} */ ([work, timeoutPromise]);
        if (abortPromise) racers.push(abortPromise);
        await Promise.race(racers);
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
            transport: TRANSPORT_NAMES.CLAUDE_AGENT_ACP
          },
          { context }
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
            transport: TRANSPORT_NAMES.CLAUDE_AGENT_ACP
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
