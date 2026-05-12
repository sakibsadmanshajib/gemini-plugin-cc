/**
 * OpenAI Chat Completions HTTP facade in front of the multi-backend CLIs.
 *
 * Any OpenAI-SDK consumer (Python `openai`, Node `openai`, curl, etc.)
 * can hit `http://localhost:<port>/v1/chat/completions` and get routed
 * to the appropriate backend (Claude / Codex / Gemini) via
 * `runStatelessTurn` under the hood. The CLI invocation is hidden.
 *
 * Why HTTP-in-front-of-CLI:
 *   - Every OpenAI SDK already speaks this API. No new client surface.
 *   - Tools that accept OPENAI_BASE_URL (LiteLLM, AutoGen, LangChain,
 *     etc.) can target this facade and use any of our three backends.
 *   - One CI binary; many client SDKs.
 *
 * Endpoints:
 *   POST /v1/chat/completions         — OpenAI Chat Completions API
 *   GET  /v1/models                   — Lists the three backends as models
 *   GET  /health                      — Liveness probe (always 200)
 *
 * Backend routing:
 *   The OpenAI request's `model` field selects the backend. Convention:
 *     - `claude*`  → BACKEND_NAMES.CLAUDE
 *     - `codex*`   → BACKEND_NAMES.CODEX
 *     - `gemini*`  → BACKEND_NAMES.GEMINI
 *     - explicit `claude:<model-id>` / `codex:<model-id>` / `gemini:<model-id>`
 *       → backend + per-invocation model override
 *
 * What IS supported:
 *   - SSE streaming (`stream: true`) — translator `agent_message_chunk`
 *     events are re-emitted as OpenAI delta chunks; client disconnect
 *     SIGTERMs the runner subprocess via the threaded AbortSignal.
 *
 * What's NOT supported (yet):
 *   - Function/tool calls in the OpenAI shape — the runners produce ACP
 *     `tool_call` updates, but mapping those to OpenAI's function-call
 *     response format is non-trivial. Deferred.
 *   - Multi-turn `messages` arrays — the runners are stateless one-shot.
 *     A multi-message request collapses into a single concatenated prompt
 *     (system + user messages joined by newlines).
 *
 * Authentication:
 *   This facade does NOT authenticate clients. It's intended for local
 *   loopback use. Run behind a reverse proxy if exposed beyond localhost.
 */

import crypto from "node:crypto";
import http from "node:http";

import getRawBody from "raw-body";

import { createAgentContext, withOverrides } from "#lib/agent-context.mjs";
import {
  getAllBackendModels,
  toOpenAiModelEntries,
} from "#lib/backends/discover-models.mjs";
import { BACKEND_NAMES, isBackendName } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

/**
 * Step 3 — parse session-policy headers from an HTTP request:
 *   `X-Artagon-Session: <id>`     → resume the named session
 *   `X-Artagon-New-Session: 1`    → start a fresh session this turn
 * Returns `{policy, conflict}`. The two headers are mutex; conflict=true
 * → caller emits 400. `policy === null` means no per-request override
 * (use the server's default session policy).
 *
 * @param {http.IncomingMessage} req
 */
function parseSessionHeaders(req) {
  const sid = req.headers["x-artagon-session"];
  const fresh = req.headers["x-artagon-new-session"];
  const sidStr = Array.isArray(sid) ? sid[0] : sid;
  const freshStr = Array.isArray(fresh) ? fresh[0] : fresh;
  const sidSet = typeof sidStr === "string" && sidStr.trim().length > 0;
  const freshSet =
    typeof freshStr === "string" &&
    (freshStr === "1" || freshStr.toLowerCase() === "true");
  if (sidSet && freshSet) {
    return { policy: null, conflict: true };
  }
  if (sidSet) {
    const trimmed = sidStr.trim();
    // G4: defense in depth. Node's outbound http rejects CR/LF in
    // header values, but validating the charset at parse time turns
    // a malformed session id into a clean 400 with an actionable
    // message instead of an opaque fetch error downstream. The id
    // formats we know about (codex UUIDs, claude UUIDs, gemini
    // session ids) all fit [A-Za-z0-9_-]{1,128}.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(trimmed)) {
      return { policy: null, conflict: true };
    }
    return {
      policy: /** @type {import("#lib/agent-context.mjs").SessionPolicy} */ ({
        action: "resume",
        id: trimmed,
      }),
      conflict: false,
    };
  }
  if (freshSet) {
    return {
      policy: /** @type {import("#lib/agent-context.mjs").SessionPolicy} */ ({
        action: "fresh",
      }),
      conflict: false,
    };
  }
  return { policy: null, conflict: false };
}

/**
 * Generate an OpenAI-style chat completion ID using crypto-strong
 * randomness. Math.random is unsuitable here (CodeQL
 * js/insecure-randomness): the id is included in error responses and
 * downstream logs, where collisions or predictable values could let an
 * attacker correlate or fake completions on a shared deployment.
 *
 * @returns {string}
 */
function generateChatCompletionId() {
  return `chatcmpl-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Map an upstream backend's stop reason to OpenAI's canonical
 * finish_reason set ("stop" | "length" | "content_filter" |
 * "tool_calls" | "function_call"). Each backend speaks its own
 * dialect:
 *   - Claude:  end_turn / max_tokens / stop_sequence / tool_use /
 *              error_max_turns / error_throttled /
 *              error_during_execution
 *   - Codex:   stop / length / tool_calls / content_filter (already
 *              OpenAI-shaped)
 *   - Gemini:  STOP / MAX_TOKENS / SAFETY / RECITATION / OTHER (all
 *              uppercase per the API)
 *
 * Without mapping, downstream OpenAI clients would see arbitrary
 * strings like "end_turn" where they expect "stop", and per-finish-
 * reason branches in user code would silently miss the upstream
 * cases (e.g. retry on length, surface a moderation flag on
 * content_filter). Returns "stop" as the safe default for unknown
 * reasons rather than passing them through opaquely.
 *
 * @param {string | null | undefined} reason
 * @returns {"stop" | "length" | "content_filter" | "tool_calls" | "function_call"}
 */
export function mapFinishReason(reason) {
  if (!reason) return "stop";
  const lower = String(reason).toLowerCase();
  // Length / token-limit dialects.
  if (
    lower === "length" ||
    lower === "max_tokens" ||
    lower === "error_max_turns"
  ) {
    return "length";
  }
  // Content-filter / safety dialects.
  if (
    lower === "content_filter" ||
    lower === "safety" ||
    lower === "recitation"
  ) {
    return "content_filter";
  }
  // Tool-call dialects.
  if (
    lower === "tool_calls" ||
    lower === "tool_use" ||
    lower === "function_call"
  ) {
    return lower === "function_call" ? "function_call" : "tool_calls";
  }
  // Stop / end-of-turn dialects + everything else.
  return "stop";
}

/**
 * Normalize the API-key option (or `$ARTAGON_FACADE_API_KEY`) into a
 * resolved allowlist of accepted bearer tokens, or null (auth
 * disabled).
 *
 * Without an API key, any client that can reach the listening
 * socket can drive turns. The default loopback bind makes that low-
 * risk, but a misconfigured deployment (binding to 0.0.0.0, port-
 * mapped under Docker) needs a defense — this is it. Constant-time
 * comparison is used to avoid timing-leak attacks against short
 * tokens.
 *
 * @param {string | string[] | undefined} key
 *   Caller-resolved key. The bin that constructs this server is the
 *   one place `ARTAGON_FACADE_API_KEY` env is read — lib accepts the
 *   value but does not consult `process.env.ARTAGON_*` directly
 *   (Phase 4 of the AgentContext refactor).
 * @param {NodeJS.ProcessEnv} [_env] Reserved for future per-request
 *   override callers; currently unused.
 * @returns {string[] | null}
 */
// eslint-disable-next-line no-unused-vars -- `_env` reserved for future override path
export function resolveApiKeyPolicy(key, _env) {
  if (typeof key === "string" && key) {
    // Comma-separated list. Single value is also fine — it just splits
    // into a one-element array.
    const list = key
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }
  if (Array.isArray(key) && key.length > 0)
    return key.filter((k) => typeof k === "string" && k);
  return null;
}

/**
 * Constant-time string equality. Avoids timing-leak attacks where an
 * attacker can deduce a token character-by-character from response
 * latency. crypto.timingSafeEqual requires same-length buffers, so we
 * pad the shorter side to match — the result is always wrong on a
 * length mismatch but the comparison itself runs in constant time.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Different length is by definition unequal; still pay a constant
    // hash to avoid leaking that fact through latency on the equal-
    // length path. timingSafeEqual on a self-buffer is constant cost.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Extract the bearer token from the Authorization header. Returns
 * the raw token (no "Bearer " prefix) or null.
 *
 * @param {http.IncomingMessage} req
 * @returns {string | null}
 */
function extractBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  // CodeQL js/polynomial-redos flagged the previous regex
  // `/^Bearer\s+(.+)$/i` because `\s+(.+)` over user-controlled
  // input is a polynomial-backtracking shape. Fixed-length string
  // parse instead — no regex engine, no backtracking, faster.
  const PREFIX = "bearer ";
  if (auth.length < PREFIX.length + 1) return null;
  if (auth.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null;
  const token = auth.slice(PREFIX.length).trim();
  return token || null;
}

/**
 * Normalize the CORS option (or the `$ARTAGON_FACADE_CORS` env var)
 * into a resolved policy: `"*"` (allow any), an array of allowed
 * origins, or `null` (CORS disabled).
 *
 * @param {string | string[] | boolean | undefined} cors
 *   Caller-resolved CORS spec. The bin reads `ARTAGON_FACADE_CORS`
 *   env and passes the resulting value here — lib does not read
 *   `process.env.ARTAGON_*` directly (Phase 4 of the AgentContext
 *   refactor).
 * @param {NodeJS.ProcessEnv} [_env] Reserved for future overrides.
 * @returns {"*" | string[] | null}
 */
// eslint-disable-next-line no-unused-vars -- `_env` reserved for future override path
export function resolveCorsPolicy(cors, _env) {
  if (cors === true) return "*";
  if (typeof cors === "string") {
    const trimmed = cors.trim();
    if (trimmed === "1" || trimmed === "true" || trimmed === "*") return "*";
    if (trimmed === "") return null;
    const list = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }
  if (Array.isArray(cors) && cors.length > 0) return [...cors];
  return null;
}

/**
 * @typedef {{
 *   role: "system" | "user" | "assistant" | "tool",
 *   content: string,
 *   name?: string
 * }} OpenAiMessage
 *
 * @typedef {{
 *   model: string,
 *   messages: OpenAiMessage[],
 *   stream?: boolean,
 *   stream_options?: { include_usage?: boolean },
 *   temperature?: number,
 *   max_tokens?: number,
 *   user?: string
 * }} OpenAiChatRequest
 *
 * @typedef {{
 *   id: string,
 *   object: "chat.completion",
 *   created: number,
 *   model: string,
 *   choices: Array<{
 *     index: number,
 *     message: { role: "assistant", content: string },
 *     finish_reason: string
 *   }>,
 *   usage: {
 *     prompt_tokens: number,
 *     completion_tokens: number,
 *     total_tokens: number
 *   }
 * }} OpenAiChatResponse
 *
 * @typedef {(
 *   backendName: string,
 *   options: any,
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * ) => Promise<import("#lib/translate/stream-runner.mjs").TurnResult>} DispatchFn
 *
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   dispatch?: DispatchFn,
 *   defaultBackend?: import("#lib/backends/names.mjs").BackendName,
 *   cors?: string | string[] | boolean,
 *   apiKey?: string | string[],
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * }} FacadeOptions
 *
 * `context` is the long-lived "server context" the daemon was booted
 * with. The request handler derives a per-request context from it via
 * `withOverrides(serverCtx, { session, … })` and passes that to
 * dispatch(). With `dispatch.streaming = "on"` on the server context,
 * the streaming supervisor cached by `(backend, cwd)` inside this
 * process survives across HTTP requests — that's the warm path.
 *
 * `apiKey` requires every /v1/* request to carry
 * `Authorization: Bearer <key>`; mismatches return 401. /health is
 * exempt (matches OpenAI's pattern; load balancers need a probe path
 * that doesn't require credentials). Pass an array to support
 * multiple valid keys (e.g. for rotation). Default off — same socket
 * reachability story as before.
 *
 * `$ARTAGON_FACADE_API_KEY` env counterpart: comma-separated list.
 *
 * `cors` opts the server into Cross-Origin Resource Sharing:
 *   - `true` or `"*"`: allow any origin (least secure; use only when
 *     you control the network)
 *   - `string`: allow exactly this origin (e.g. `"http://localhost:3000"`)
 *   - `string[]`: allowlist; the request's `Origin` must match exactly
 *   - omitted / falsy: no CORS headers, no preflight handling (default)
 *
 * Without `cors`, browser-based clients (Vercel AI SDK, in-browser
 * openai SDK, etc.) can't reach the facade due to the same-origin
 * policy. With `cors: "*"`, any malicious page the user visits could
 * pump prompts at the local server — that's why it's opt-in.
 *
 * `$ARTAGON_FACADE_CORS` is read at construction time when `cors` is
 * not passed: `"1"` / `"true"` / `"*"` → allow all; otherwise treated
 * as a comma-separated allowlist.
 */

/**
 * Resolve the OpenAI request's `model` field to a backend + optional
 * model override. Conventions:
 *   - `claude` / `claude-*`   → CLAUDE backend
 *   - `codex` / `codex-*` / `gpt-5` / `gpt-5-codex` / `o3*` / `o4*` → CODEX
 *   - `gemini` / `gemini-*`   → GEMINI backend
 *   - `<backend>:<model>`     → explicit; model override applied
 *
 * Returns null if the model can't be mapped.
 *
 * @param {string} model
 * @returns {{ backend: import("#lib/backends/names.mjs").BackendName, modelOverride: string | undefined } | null}
 */
export function resolveModelToBackend(model) {
  if (typeof model !== "string" || !model) return null;

  // Explicit `<backend>:<model>` syntax wins.
  const colonIdx = model.indexOf(":");
  if (colonIdx > 0) {
    const prefix = model.slice(0, colonIdx);
    const suffix = model.slice(colonIdx + 1);
    if (isBackendName(prefix)) {
      return { backend: prefix, modelOverride: suffix || undefined };
    }
  }

  const lower = model.toLowerCase();
  if (
    lower === "claude" ||
    lower.startsWith("claude-") ||
    lower.startsWith("sonnet") ||
    lower.startsWith("opus") ||
    lower.startsWith("haiku")
  ) {
    return { backend: BACKEND_NAMES.CLAUDE, modelOverride: model };
  }
  if (
    lower === "codex" ||
    lower.startsWith("codex-") ||
    lower.startsWith("gpt-5") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower === "spark"
  ) {
    return { backend: BACKEND_NAMES.CODEX, modelOverride: model };
  }
  if (
    lower === "gemini" ||
    lower.startsWith("gemini-") ||
    lower.startsWith("auto-gemini")
  ) {
    return { backend: BACKEND_NAMES.GEMINI, modelOverride: model };
  }
  return null;
}

/**
 * Collapse OpenAI's `messages[]` into a single prompt string. The
 * runners are stateless one-shot; multi-turn isn't supported. We
 * preserve the role headers so the model can still distinguish system
 * from user content.
 *
 * @param {OpenAiMessage[]} messages
 * @returns {string}
 */
export function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .map((m) => {
      const role =
        m.role === "user"
          ? "User"
          : m.role === "system"
            ? "System"
            : "Assistant";
      const content = typeof m.content === "string" ? m.content : "";
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

/**
 * Build an OpenAI Chat Completions response from a TurnResult.
 *
 * @param {string} requestModel
 * @param {import("#lib/translate/stream-runner.mjs").TurnResult} turn
 * @returns {OpenAiChatResponse}
 */
export function turnResultToOpenAiResponse(requestModel, turn) {
  // OpenAI's usage shape uses prompt_tokens/completion_tokens/total_tokens.
  // Map from whichever input/output_tokens the upstream backend reported.
  const usage = turn.usage ?? {};
  /** @type {any} */
  const u = usage;
  const prompt = u.input_tokens ?? u.promptTokenCount ?? u.prompt_tokens ?? 0;
  const completion =
    u.output_tokens ?? u.candidatesTokenCount ?? u.completion_tokens ?? 0;
  const total = u.total_tokens ?? u.totalTokenCount ?? prompt + completion;

  return {
    id: generateChatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: turn.text },
        finish_reason: mapFinishReason(turn.reason),
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    },
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * OpenAI's error response shape is consistent:
 *   { error: { message, type, code?, param?, backend? } }
 *
 * 8+ call sites in this file built that object inline. Extracted
 * here so adding a new error response is one line and we never
 * forget the wrapper. Keeps the call sites readable.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {{ type?: string, code?: string, param?: string, backend?: string }} [extra]
 */
function sendError(res, status, message, extra = {}) {
  /** @type {Record<string, string>} */
  const error = {
    message,
    type: extra.type ?? "invalid_request_error",
  };
  if (extra.code) error.code = extra.code;
  if (extra.param) error.param = extra.param;
  if (extra.backend) error.backend = extra.backend;
  sendJson(res, status, { error });
}

/**
 * Read the full request body (POST JSON). Resolves with the parsed
 * object or rejects on parse error / oversized body.
 *
 * Uses `raw-body` (Express team, 4M weekly downloads) for the
 * chunk-buffering + size-cap + draining concerns. Drops ~25 lines of
 * hand-rolled stream code that we already had to fix once for
 * ECONNRESET on req.destroy() — raw-body handles that correctly.
 * Errors thrown by raw-body have a `.statusCode` field
 * (413 entity-too-large, 500 stream-error) we map onto our 400/413
 * response taxonomy.
 *
 * @param {http.IncomingMessage} req
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<any>}
 */
async function readJsonBody(req, options = {}) {
  const limit = options.maxBytes ?? 1 << 20; // 1 MiB
  const text = await getRawBody(req, {
    length: req.headers["content-length"],
    limit,
    encoding: "utf-8",
  });
  return text ? JSON.parse(text) : {};
}

/**
 * Handle a `stream: true` Chat Completions request via SSE. Each
 * incoming `agent_message_chunk` from the underlying CLI becomes one
 * OpenAI delta chunk on the wire; the final chunk carries
 * `finish_reason` + `data: [DONE]\n\n` per OpenAI's spec.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {OpenAiChatRequest} body
 * @param {{ backend: import("#lib/backends/names.mjs").BackendName, modelOverride: string | undefined }} resolved
 * @param {DispatchFn} dispatch
 * @param {string} prompt
 * @param {import("#lib/agent-context.mjs").AgentContext} [serverContext]
 */
async function handleStreamingChatCompletion(
  req,
  res,
  body,
  resolved,
  dispatch,
  prompt,
  serverContext,
) {
  const id = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering when proxied.
  });

  // Single source of truth for "is this stream still alive?" — set by
  // req.on("close") (client disconnect) AND by res.on("error") (socket
  // error mid-write). Every res.write goes through sendChunk, which
  // bails on `aborted` so we never write to a destroyed socket.
  let aborted = false;
  const abortController = new AbortController();
  req.on("close", () => {
    if (!aborted) {
      aborted = true;
      // Cascade the abort to the backend runner so the spawned CLI is
      // SIGTERMed instead of running until timeoutMs (otherwise a
      // disconnected client leaves the subprocess alive for ~5min).
      abortController.abort(new Error("client disconnected"));
    }
  });
  res.on("error", () => {
    if (!aborted) {
      aborted = true;
      abortController.abort(new Error("response stream errored"));
    }
  });

  /**
   * Emit an OpenAI streaming chunk. Guards every write with `aborted`
   * + `res.writableEnded` so we never write to a destroyed socket.
   *
   * @param {{ content?: string, role?: "assistant" }} delta
   * @param {string | null} finishReason
   */
  function sendChunk(delta, finishReason) {
    if (aborted || res.writableEnded) return;
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    try {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } catch {
      // Write race with client disconnect; mark aborted so subsequent
      // writes don't pile errors.
      aborted = true;
      abortController.abort(new Error("write after close"));
    }
  }

  // First chunk announces the assistant role per the OpenAI streaming spec.
  sendChunk({ role: "assistant" }, null);

  try {
    const turn = await dispatch(
      resolved.backend,
      {
        prompt,
        model: resolved.modelOverride,
        timeoutMs: 5 * 60 * 1000,
        // Thread the abort signal so the runner SIGTERMs the subprocess
        // when the client disconnects.
        signal: abortController.signal,
        onUpdate: (/** @type {any} */ update) => {
          if (aborted) return;
          if (update?.sessionUpdate === "agent_message_chunk") {
            const text = update.content?.text ?? "";
            if (text) sendChunk({ content: text }, null);
          }
          // agent_thought_chunk, tool_call, tool_result, turn_completed
          // are NOT mapped to delta content — OpenAI's streaming format
          // doesn't have a clean home for them. Tools especially would
          // need delta.tool_calls; deferred (see facade comment).
        },
      },
      serverContext,
    );

    if (!aborted) {
      sendChunk({}, mapFinishReason(turn.reason));
      // OpenAI extension: stream_options.include_usage tells the
      // server to emit an extra chunk with usage tallies after the
      // final delta but BEFORE [DONE]. The chunk has `choices: []`
      // and a populated `usage` object. Useful for clients that need
      // accurate token accounting on streamed responses.
      if (body.stream_options?.include_usage && !res.writableEnded) {
        /** @type {any} */
        const u = turn.usage ?? {};
        const prompt =
          u.input_tokens ?? u.promptTokenCount ?? u.prompt_tokens ?? 0;
        const completion =
          u.output_tokens ?? u.candidatesTokenCount ?? u.completion_tokens ?? 0;
        const total =
          u.total_tokens ?? u.totalTokenCount ?? prompt + completion;
        try {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [],
              usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: total,
              },
            })}\n\n`,
          );
        } catch {
          // best-effort; if the socket dies between the final delta
          // and the usage chunk, just skip — [DONE] handles cleanup.
        }
      }
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
    }
  } catch (err) {
    if (!aborted) {
      // Same redaction as the non-streaming path: log the detail to
      // stderr; return only the backend name + a generic message
      // (CodeQL js/stack-trace-exposure).
      const detail =
        err instanceof Error
          ? (err.stack ?? err.message)
          : typeof err === "object" && err !== null && "exitCode" in err
            ? `${resolved.backend} CLI exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
            : String(err);
      try {
        process.stderr.write(
          `openai-facade: backend_error (${resolved.backend}) ${detail}\n`,
        );
      } catch {
        // best-effort
      }
      sendChunk({}, "stop");
      if (!res.writableEnded) {
        try {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `${resolved.backend} backend failed; check server logs for detail`,
                type: "backend_error",
                backend: resolved.backend,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
        } catch {
          // best-effort
        }
      }
    }
  }

  if (!res.writableEnded) {
    try {
      res.end();
    } catch {
      // best-effort
    }
  }
}

/**
 * Build (but don't start) the OpenAI facade HTTP server.
 *
 * @param {FacadeOptions} [options]
 * @returns {{
 *   server: http.Server,
 *   listen: (port?: number) => Promise<{ port: number, host: string }>,
 *   close: () => Promise<void>,
 *   address: () => { port: number, host: string } | null
 * }}
 */
export function createOpenAiFacadeServer(options = {}) {
  const dispatch = options.dispatch ?? runStatelessTurn;
  const host = options.host ?? "127.0.0.1";
  const corsPolicy = resolveCorsPolicy(options.cors);
  const apiKeyPolicy = resolveApiKeyPolicy(options.apiKey);
  // Server context is captured at boot. Per-request overrides (session,
  // trace-id, etc.) are derived via withOverrides on the request path
  // — see step 3 of the facade-unification plan.
  const serverContext = options.context;

  /**
   * Resolve a request's `Origin` against the CORS policy. Returns the
   * value that should land in `Access-Control-Allow-Origin` (echoed
   * origin, `"*"`, or null when CORS shouldn't be applied).
   *
   * @param {string | undefined} origin
   * @returns {string | null}
   */
  function allowedOrigin(origin) {
    if (!corsPolicy) return null;
    if (corsPolicy === "*") return "*";
    if (!origin) return null;
    return corsPolicy.includes(origin) ? origin : null;
  }

  /** @param {http.ServerResponse} res @param {string} originValue */
  function setCorsHeaders(res, originValue) {
    res.setHeader("Access-Control-Allow-Origin", originValue);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }

  const server = http.createServer(async (req, res) => {
    try {
      // CORS preflight + per-response header injection. Done before
      // route dispatch so OPTIONS short-circuits without parsing a
      // body, and so error responses also carry the headers.
      const origin = /** @type {string | undefined} */ (req.headers.origin);
      const allowOrigin = allowedOrigin(origin);
      if (allowOrigin) setCorsHeaders(res, allowOrigin);
      if (req.method === "OPTIONS") {
        // 204 No Content per CORS preflight convention. Headers are
        // already set above when the policy allows the origin.
        res.writeHead(allowOrigin ? 204 : 405);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        // /health is exempt from API-key auth — load balancers need
        // a probe path that doesn't require credentials. Same as
        // OpenAI's pattern.
        sendJson(res, 200, { ok: true });
        return;
      }

      // API-key auth gate. /v1/* requests must carry an
      // `Authorization: Bearer <key>` matching the configured policy.
      // Mismatch / missing header → 401 with a WWW-Authenticate hint.
      // CORS preflight (OPTIONS) was already handled above without
      // parsing a body; auth is checked AFTER that so browser clients
      // can still preflight.
      if (apiKeyPolicy) {
        const presented = extractBearerToken(req);
        const ok =
          presented != null &&
          apiKeyPolicy.some((k) => constantTimeEquals(presented, k));
        if (!ok) {
          res.setHeader(
            "WWW-Authenticate",
            'Bearer realm="artagon-openai-server"',
          );
          sendError(
            res,
            401,
            "Missing or invalid API key. Send Authorization: Bearer <key> matching the server's configured key.",
            { code: "invalid_api_key" },
          );
          return;
        }
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        // Aggregate all backends' declared modelAliases into the
        // standard OpenAI list shape. Each canonical id + each alias
        // appears as a separate `id` so clients can use either form.
        // See lib/backends/discover-models.mjs for source-of-truth.
        const models = getAllBackendModels();
        /** @type {Array<{ id: string, object: "model", created: number, owned_by: string }>} */
        const data = [];
        for (const m of models) {
          data.push(...toOpenAiModelEntries(m));
        }
        sendJson(res, 200, { object: "list", data });
        return;
      }

      // GET /v1/models/{id} — single-model retrieval. OpenAI clients
      // sometimes hit this to verify a model exists before posting a
      // chat completion. Match against the same alias set /v1/models
      // exposes; 404 on unknown id.
      if (req.method === "GET" && req.url?.startsWith("/v1/models/")) {
        const id = decodeURIComponent(req.url.slice("/v1/models/".length));
        const all = [];
        for (const m of getAllBackendModels())
          all.push(...toOpenAiModelEntries(m));
        const found = all.find((entry) => entry.id === id);
        if (found) {
          sendJson(res, 200, found);
        } else {
          sendError(
            res,
            404,
            `model "${id}" not found. See GET /v1/models for the supported list.`,
            { param: "id" },
          );
        }
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        // Parse the body. Bad JSON is a CLIENT error → 400, not a 500.
        // Oversized body is 413. Anything else propagates to the global
        // 500 handler.
        /** @type {OpenAiChatRequest} */
        let body;
        try {
          body = /** @type {any} */ (await readJsonBody(req));
        } catch (err) {
          // raw-body errors carry a `.statusCode` (413 for too-big,
          // 415 for bad encoding, 400 for malformed length). JSON
          // parse errors don't have one — they fall through to 400.
          const statusCode = /** @type {any} */ (err)?.statusCode;
          const message = err instanceof Error ? err.message : String(err);
          if (statusCode === 413) {
            sendError(res, 413, "request body too large (max 1 MiB)");
            return;
          }
          // JSON.parse, length-mismatch, and req-error get bundled
          // here — all client-recoverable.
          sendError(res, 400, `invalid JSON body: ${message}`);
          return;
        }

        const resolved = resolveModelToBackend(body.model || "");
        if (!resolved) {
          sendError(
            res,
            400,
            `Cannot resolve model "${body.model}" to a backend. Use claude*, codex*, gemini*, or "<backend>:<model-id>".`,
          );
          return;
        }

        const prompt = flattenMessages(body.messages);
        if (!prompt) {
          sendError(
            res,
            400,
            "messages[] is required and must contain at least one message with content.",
          );
          return;
        }

        // Reject `n != 1` upfront — the runners produce one completion
        // per turn and silently returning a single choice when the
        // client asked for several breaks the OpenAI contract (clients
        // index choices[0..n-1] expecting all to be present). Better
        // to fail fast with a clear error than confuse downstream code.
        const requestedN = /** @type {any} */ (body).n;
        if (requestedN !== undefined && requestedN !== 1) {
          sendError(
            res,
            400,
            "n != 1 is not supported. The runners produce one completion per turn; " +
              "issue parallel requests if you need multiple completions.",
            { param: "n" },
          );
          return;
        }

        // Step 3 — per-request session policy via headers.
        const sessionHdr = parseSessionHeaders(req);
        if (sessionHdr.conflict) {
          sendError(
            res,
            400,
            "Invalid session header: either X-Artagon-Session and X-Artagon-New-Session " +
              "were both set (they are mutually exclusive — pick one per request), " +
              "OR X-Artagon-Session contained characters outside /^[A-Za-z0-9_-]{1,128}$/.",
            { type: "invalid_request_error", param: "x-artagon-session" },
          );
          return;
        }
        let requestContext = serverContext;
        if (sessionHdr.policy) {
          // G5: when serverContext is present, layer the session
          // override on top of it (inheriting cwd, env, logging, cost,
          // etc.). When the caller built the facade WITHOUT a
          // serverContext (a test injecting a fake dispatch), build a
          // minimal default context — but do NOT hard-code streaming
          // on. That would silently route through the streaming runner
          // when the test owner expected cold-start. Defaults are
          // tri-state "default" across the board; the bin layer is
          // responsible for opting into streaming.
          requestContext = serverContext
            ? withOverrides(serverContext, { session: sessionHdr.policy })
            : createAgentContext({
                session: sessionHdr.policy,
                dispatch: { streaming: "default", facade: "default" },
              });
        }

        if (body.stream === true) {
          await handleStreamingChatCompletion(
            req,
            res,
            body,
            resolved,
            dispatch,
            prompt,
            requestContext,
          );
          return;
        }

        try {
          const turn = await dispatch(
            resolved.backend,
            {
              prompt,
              model: resolved.modelOverride,
              timeoutMs: 5 * 60 * 1000,
            },
            requestContext,
          );
          // Echo the effective session id back so clients can persist
          // it for follow-up requests.
          if (turn.sessionId) {
            res.setHeader("X-Artagon-Session", turn.sessionId);
          }
          sendJson(res, 200, turnResultToOpenAiResponse(body.model, turn));
        } catch (err) {
          // Log the full backend error to stderr; return only the
          // backend name + a generic message to clients (CodeQL
          // js/stack-trace-exposure flagged the prior err.message
          // passthrough — vendor CLI errors can echo prompts or
          // env-derived info that shouldn't land in the HTTP body).
          const detail =
            err instanceof Error
              ? (err.stack ?? err.message)
              : typeof err === "object" && err !== null && "exitCode" in err
                ? `${resolved.backend} CLI exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
                : String(err);
          try {
            process.stderr.write(
              `openai-facade: backend_error (${resolved.backend}) ${detail}\n`,
            );
          } catch {
            // best-effort
          }
          sendError(
            res,
            502,
            `${resolved.backend} backend failed; check server logs for detail`,
            {
              type: "backend_error",
              backend: resolved.backend,
            },
          );
        }
        return;
      }

      sendError(res, 404, "not found");
    } catch (err) {
      // Don't leak err.message / err.stack to clients (CodeQL
      // js/stack-trace-exposure). Internal errors here mean a bug or
      // an unexpected request shape; the server-side stderr trace is
      // the right place for the detail.
      try {
        process.stderr.write(
          `openai-facade: server_error ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      } catch {
        // best-effort
      }
      sendError(res, 500, "internal server error", { type: "server_error" });
    }
  });

  return {
    server,
    listen(port) {
      const targetPort = port ?? options.port ?? 0; // 0 = OS-assigned
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(targetPort, host, () => {
          server.removeListener("error", reject);
          const address = /** @type {import("node:net").AddressInfo} */ (
            server.address()
          );
          resolve({ port: address.port, host });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    address() {
      const a = server.address();
      if (!a || typeof a === "string") return null;
      return { port: a.port, host: a.address };
    },
  };
}
