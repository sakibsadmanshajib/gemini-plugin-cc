/**
 * Facade dispatch — route a one-shot turn through a running
 * `artagon-openai-server` instead of cold-spawning a CLI.
 *
 * Why exist:
 *   When the operator runs `artagon-openai-server` persistently, every
 *   subsequent cross-driver call can route HTTP to that server rather
 *   than fork-and-exec'ing the backend CLI from scratch.
 *
 *   Two amortizations:
 *
 *     1. Cache hit  → pure HTTP round-trip; no CLI spawn at all.
 *                     (lib/middleware/cache.mjs in the facade serves it)
 *     2. Cache miss → facade still spawns the CLI for that turn, but
 *                     `node` itself was already loaded in the facade
 *                     process. Saves the per-call ~500ms node bootstrap.
 *
 * Opt-in only: dispatcher's default behavior is unchanged. Operator
 * sets `ARTAGON_USE_FACADE=1` (or passes `useFacade: true` on options)
 * to enable.
 *
 * Auth: when the facade has --auto-key enabled, the manifest contains
 * the retrieve-command. Caller MUST run that command and pass the
 * resulting key in `process.env.ARTAGON_FACADE_API_KEY` (or via
 * `options.bearerToken`). Dispatcher never reads keys from disk; the
 * operator's choice of how to surface the key is theirs.
 *
 * Failure mode: any error → reject. Caller (the dispatcher) catches
 * and falls back to the cold-start path.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { TRANSPORT_NAMES } from "#lib/cost/transport-names.mjs";
import { readManifest } from "#lib/server/facade-endpoint.mjs";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   prompt: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   model?: string,
 *   timeoutMs?: number,
 *   bearerToken?: string,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 * }} RunViaFacadeOptions
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/backends/names.mjs").BackendName} BackendName
 */

/**
 * Resolve the bearer token to use against the facade. Order:
 *   1. options.bearerToken (explicit)
 *   2. context.facade.apiKey (set by boundary builder from CLI / env)
 *   3. null (no auth header sent — facade may reject)
 *
 * The `ARTAGON_FACADE_API_KEY` env-var read was removed in Phase 4 of
 * the AgentContext refactor. Boundary callers translate the legacy env
 * into `context.facade.apiKey` before reaching this function.
 *
 * @param {RunViaFacadeOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {string | null}
 */
function resolveBearer(options, context) {
  if (typeof options.bearerToken === "string" && options.bearerToken !== "") {
    return options.bearerToken;
  }
  const fromContext = context?.facade?.apiKey;
  if (typeof fromContext === "string" && fromContext !== "") return fromContext;
  return null;
}

/**
 * POST a chat completion to the facade and accumulate the response into
 * a TurnResult. The facade emits OpenAI Chat Completions shape; we map
 * that back to our TurnResult.
 *
 * Streaming is OFF in this implementation — non-streaming is simpler
 * and the facade returns the same total payload either way. (Future
 * enhancement: SSE streaming with `onUpdate` per chunk.)
 *
 * @param {BackendName} backend
 * @param {RunViaFacadeOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 *   When set, `context.facade.apiKey` is used as the bearer token
 *   (falling back to `options.bearerToken` if both are present).
 * @returns {Promise<TurnResult>}
 */
export async function runViaFacade(backend, options, context) {
  const manifest = readManifest(context?.env ?? options.env ?? process.env);
  if (!manifest) {
    throw new Error("runViaFacade: no running facade found (manifest absent or stale)");
  }

  const startedAtMs = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `http://${manifest.host}:${manifest.port}/v1/chat/completions`;
  const bearer = resolveBearer(options, context);

  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  // Step 3: forward the session policy from this client's context to
  // the daemon via X-Artagon-Session / X-Artagon-New-Session headers.
  // The daemon's request handler re-derives a per-request AgentContext
  // from these so the streaming runner inside the daemon honors them.
  const sessionAction = context?.session?.action;
  if (sessionAction === "resume") {
    headers["X-Artagon-Session"] = /** @type {{ action: "resume", id: string }} */ (
      /** @type {any} */ (context.session)
    ).id;
  } else if (sessionAction === "fresh") {
    headers["X-Artagon-New-Session"] = "1";
  }

  const body = JSON.stringify({
    model: resolveModel(backend, options.model),
    messages: [{ role: "user", content: options.prompt }],
    stream: false
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    sessionId: null,
    updates: []
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } catch (err) {
    appendCostRecord(
      {
        backend,
        model: null,
        promptChars: options.prompt.length,
        usage: normalizeUsage(null),
        durationMs: Date.now() - startedAtMs,
        reason: null,
        ok: false,
        transport: TRANSPORT_NAMES.FACADE
      },
      { context }
    );
    clearTimeout(timer);
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    appendCostRecord(
      {
        backend,
        model: null,
        promptChars: options.prompt.length,
        usage: normalizeUsage(null),
        durationMs: Date.now() - startedAtMs,
        reason: null,
        ok: false,
        transport: TRANSPORT_NAMES.FACADE
      },
      { context }
    );
    throw new Error(
      `runViaFacade: facade returned ${response.status} ${response.statusText} ${text}`
    );
  }

  const json = /** @type {any} */ (await response.json());
  const choice = json?.choices?.[0];
  if (choice?.message?.content) {
    turn.text = String(choice.message.content);
    turn.chunkCount = 1;
    turn.chunkChars = turn.text.length;
  }
  if (choice?.finish_reason) {
    turn.reason = String(choice.finish_reason);
  }
  if (json?.usage) {
    turn.usage = json.usage;
  }
  if (json?.model) {
    turn.model = String(json.model);
  }
  // Step 3: surface the daemon's effective session id back to the
  // caller via response header so they can persist it.
  const echoedSession = response.headers.get("x-artagon-session");
  if (echoedSession) {
    turn.sessionId = echoedSession;
  }
  // Tool calls in OpenAI shape: choice.message.tool_calls = [{id, type, function:{name, arguments}}]
  if (Array.isArray(choice?.message?.tool_calls)) {
    for (const tc of choice.message.tool_calls) {
      const id = String(tc.id ?? "");
      const name = String(tc.function?.name ?? "unknown");
      let args;
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        args = tc.function?.arguments ?? {};
      }
      turn.toolCalls.push({ toolName: name, toolUseId: id, args });
    }
  }

  appendCostRecord(
    {
      backend,
      model: turn.model ?? null,
      promptChars: options.prompt.length,
      usage: normalizeUsage(turn.usage ?? null),
      durationMs: Date.now() - startedAtMs,
      reason: turn.reason ?? null,
      ok: true,
      transport: TRANSPORT_NAMES.FACADE
    },
    { context }
  );

  return turn;
}

/**
 * Map a backend name to a model id the facade will accept. The facade
 * understands `<backend>:<model>` form OR a backend name alone (it picks
 * a default). Caller's `options.model` wins when set.
 *
 * @param {BackendName} backend
 * @param {string | undefined} explicitModel
 * @returns {string}
 */
function resolveModel(backend, explicitModel) {
  if (typeof explicitModel === "string" && explicitModel !== "") {
    return explicitModel;
  }
  switch (backend) {
    case BACKEND_NAMES.CLAUDE:
      return "claude";
    case BACKEND_NAMES.CODEX:
      return "codex";
    case BACKEND_NAMES.GEMINI:
      return "gemini";
    default:
      return "claude";
  }
}
