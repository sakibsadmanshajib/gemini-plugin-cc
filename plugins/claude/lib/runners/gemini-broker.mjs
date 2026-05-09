/**
 * Gemini broker runner — connect to an existing `gemini --acp` broker
 * over its Unix socket and run a one-shot turn through it.
 *
 * Sibling of `runGeminiPrint`. The cold-start runner spawns a fresh
 * `gemini -p` per call (~3-5s startup tax). When a long-running broker
 * is already alive for the cwd (legacy `/gemini:*` slash commands keep
 * one resident), this runner connects to it instead — turning a cold
 * call into a ~50-500ms warm round-trip.
 *
 * Transport: `lib/transport/broker-socket.mjs::createBrokerSocketTransport`
 * Protocol:  ACP `initialize` → `session/new` → `session/prompt`,
 *            accumulating `session/update` notifications until
 *            `stop_reason` is set on the prompt response.
 *
 * The broker probe (`lib/transport/broker-probe.mjs::findActiveBroker`)
 * is the entry point; this runner accepts an already-validated endpoint.
 * Callers (the dispatcher) probe FIRST, then call this runner ONLY when
 * the probe returned a non-null endpoint.
 *
 * Failure mode: any error connecting/talking to the broker rejects the
 * promise. The dispatcher catches and falls back to `runGeminiPrint`.
 *
 * Cost record: emits `transport: "broker"` so observability can
 * distinguish broker vs cold-start ratios.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { translateGeminiStreamEvent } from "#lib/translate/gemini-stream.mjs";
import { createBrokerSocketTransport } from "#lib/transport/broker-socket.mjs";

import { createAcpClient } from "../acp/client.mjs";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PROTOCOL_VERSION = 1;

/**
 * @typedef {{
 *   endpoint: string,
 *   prompt: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   sessionId?: string,
 *   approvalMode?: "default" | "auto_edit" | "yolo" | "plan",
 *   model?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 *   connectTimeoutMs?: number
 * }} RunGeminiBrokerOptions
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/translate/stream-runner.mjs").SessionUpdate} SessionUpdate
 */

/**
 * Run a single turn through an existing gemini broker.
 *
 * @param {RunGeminiBrokerOptions} options
 * @returns {Promise<TurnResult>}
 */
export async function runGeminiViaBroker(options) {
  const { endpoint, prompt } = options;
  if (typeof endpoint !== "string" || endpoint === "") {
    throw new Error("runGeminiViaBroker: endpoint is required");
  }
  if (typeof prompt !== "string" || prompt === "") {
    throw new Error("runGeminiViaBroker: prompt is required");
  }

  const startedAtMs = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // TurnResult accumulator — same shape as runGeminiPrint produces.
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

  const transport = createBrokerSocketTransport({
    endpoint,
    connectTimeoutMs: options.connectTimeoutMs
  });
  const client = createAcpClient(/** @type {any} */ (transport));

  const unsubscribe = client.onNotification((notification) => {
    accumulate(turn, notification, options.onUpdate);
  });

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let abortListener = null;

  try {
    await transport.start();

    if (options.signal) {
      const onAbort = () => {
        try {
          transport.close();
        } catch {
          // best-effort
        }
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
    }

    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`runGeminiViaBroker: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const work = (async () => {
      // 1. initialize — ACP handshake. The broker is already running its
      //    own initialize against the gemini child, so this is essentially
      //    a no-op for the child but required by protocol on this client.
      await client.request("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      // 2. session/new (or session/load when sessionId is provided).
      let sessionId = options.sessionId ?? null;
      if (sessionId) {
        await client.request("session/load", {
          sessionId,
          cwd: options.cwd ?? process.cwd(),
          mcpServers: []
        });
      } else {
        const session = await client.request("session/new", {
          cwd: options.cwd ?? process.cwd(),
          mcpServers: []
        });
        sessionId = /** @type {any} */ (session)?.sessionId ?? null;
      }

      // 3. session/prompt — the actual turn. session/update notifications
      //    arrive on the onNotification handler above and accumulate into
      //    `turn`. The response carries the final stop_reason; we read
      //    `usage` and `reason` from it as a back-stop in case the
      //    translator missed them.
      const response = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      });

      const responseAsAny = /** @type {any} */ (response);
      if (responseAsAny?.stopReason && !turn.reason) {
        turn.reason = String(responseAsAny.stopReason);
      }
      if (responseAsAny?.usage && !turn.usage) {
        turn.usage = responseAsAny.usage;
      }
    })();

    await Promise.race([work, timeoutPromise]);
  } catch (err) {
    appendCostRecord({
      backend: BACKEND_NAMES.GEMINI,
      model: turn.model ?? null,
      promptChars: prompt.length,
      usage: normalizeUsage(turn.usage ?? null),
      durationMs: Date.now() - startedAtMs,
      reason: turn.reason ?? null,
      ok: false,
      transport: "broker"
    });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) abortListener();
    unsubscribe();
    try {
      await transport.close();
    } catch {
      // best-effort; we already have the turn data
    }
  }

  appendCostRecord({
    backend: BACKEND_NAMES.GEMINI,
    model: turn.model ?? null,
    promptChars: prompt.length,
    usage: normalizeUsage(turn.usage ?? null),
    durationMs: Date.now() - startedAtMs,
    reason: turn.reason ?? null,
    ok: true,
    transport: "broker"
  });

  return turn;
}

/**
 * Apply a session/update notification to the accumulator. Extracted to
 * keep the protocol driver readable. Mirrors what
 * `consumeStreamJson` does for the cold-start path, but driven by ACP
 * notifications instead of stdout-line events.
 *
 * @param {TurnResult} turn
 * @param {import("#lib/acp/types.mjs").JsonRpcNotification} notification
 * @param {((u: SessionUpdate) => void) | undefined} onUpdate
 */
function accumulate(turn, notification, onUpdate) {
  if (!notification || notification.method !== "session/update") return;
  const params = /** @type {any} */ (notification.params);
  if (!params || !params.update) return;

  const sessionUpdate = translateGeminiStreamEvent(params.update);
  if (!sessionUpdate) return;
  const updates = Array.isArray(sessionUpdate) ? sessionUpdate : [sessionUpdate];
  for (const u of updates) {
    turn.updates.push(u);
    if (onUpdate) {
      try {
        onUpdate(u);
      } catch {
        // caller bug; don't let it kill the turn
      }
    }
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.text ?? "";
        turn.text += text;
        turn.chunkCount += 1;
        turn.chunkChars += text.length;
        break;
      }
      case "agent_thought_chunk": {
        const text = u.content?.text ?? "";
        turn.thoughtText += text;
        turn.thoughtCount += 1;
        turn.thoughtChars += text.length;
        break;
      }
      case "tool_call":
        if (u.toolName && u.toolUseId !== undefined) {
          turn.toolCalls.push({
            toolName: u.toolName,
            toolUseId: u.toolUseId,
            args: u.args ?? {}
          });
        }
        break;
      case "tool_result":
        if (u.toolUseId !== undefined) {
          turn.toolResults.push({
            toolUseId: u.toolUseId,
            result: u.result ?? null,
            isError: Boolean(u.isError)
          });
        }
        break;
      case "turn_completed":
        if (u.reason && !turn.reason) turn.reason = u.reason;
        if (u.usage && !turn.usage) turn.usage = u.usage;
        if (u.model && !turn.model) turn.model = u.model;
        break;
      default:
        break;
    }
  }
}
