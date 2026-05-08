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

import { getAllBackendModels, toOpenAiModelEntries } from "#lib/backends/discover-models.mjs";
import { BACKEND_NAMES, isBackendName } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

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
 * Normalize the CORS option (or the `$ARTAGON_FACADE_CORS` env var)
 * into a resolved policy: `"*"` (allow any), an array of allowed
 * origins, or `null` (CORS disabled).
 *
 * @param {string | string[] | boolean | undefined} cors
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"*" | string[] | null}
 */
export function resolveCorsPolicy(cors, env = process.env) {
  // Direct option wins.
  if (cors === true || cors === "*") return "*";
  if (typeof cors === "string" && cors) return [cors];
  if (Array.isArray(cors) && cors.length > 0) return [...cors];
  if (cors !== undefined) return null; // explicitly false / empty string / empty array

  // Fall back to env when the option wasn't passed.
  const envValue = env.ARTAGON_FACADE_CORS;
  if (!envValue) return null;
  const trimmed = envValue.trim();
  if (trimmed === "1" || trimmed === "true" || trimmed === "*") return "*";
  // Comma-separated allowlist.
  const list = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
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
 * @typedef {(backendName: string, options: any) => Promise<import("#lib/translate/stream-runner.mjs").TurnResult>} DispatchFn
 *
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   dispatch?: DispatchFn,
 *   defaultBackend?: import("#lib/backends/names.mjs").BackendName,
 *   cors?: string | string[] | boolean
 * }} FacadeOptions
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
  if (lower === "gemini" || lower.startsWith("gemini-") || lower.startsWith("auto-gemini")) {
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
      const role = m.role === "user" ? "User" : m.role === "system" ? "System" : "Assistant";
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
  const completion = u.output_tokens ?? u.candidatesTokenCount ?? u.completion_tokens ?? 0;
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
        finish_reason: turn.reason ?? "stop"
      }
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total
    }
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
    "Content-Length": Buffer.byteLength(payload).toString()
  });
  res.end(payload);
}

/**
 * Read the full request body (POST JSON). Resolves with the parsed
 * object or rejects on parse error / oversized body.
 *
 * @param {http.IncomingMessage} req
 * @param {{ maxBytes?: number }} [options]
 */
function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? 1 << 20; // 1 MiB
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let overLimit = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop accumulating to bound memory, but keep draining the
        // socket so the caller can send a 413 response cleanly. If we
        // call req.destroy() here the response write race-loses to
        // ECONNRESET on the client side.
        overLimit = true;
        chunks.length = 0;
        return;
      }
      if (!overLimit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overLimit) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
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
 */
async function handleStreamingChatCompletion(req, res, body, resolved, dispatch, prompt) {
  const id = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no" // Disable nginx buffering when proxied.
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
      choices: [{ index: 0, delta, finish_reason: finishReason }]
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
    const turn = await dispatch(resolved.backend, {
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
      }
    });

    if (!aborted) {
      sendChunk({}, turn.reason ?? "stop");
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
    }
  } catch (err) {
    if (!aborted) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "exitCode" in err
            ? `${resolved.backend} CLI exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
            : String(err);
      sendChunk({}, "stop");
      if (!res.writableEnded) {
        try {
          res.write(
            `data: ${JSON.stringify({ error: { message, type: "backend_error", backend: resolved.backend } })}\n\n`
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
        sendJson(res, 200, { ok: true });
        return;
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

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        // Parse the body. Bad JSON is a CLIENT error → 400, not a 500.
        // Oversized body is 413. Anything else propagates to the global
        // 500 handler.
        /** @type {OpenAiChatRequest} */
        let body;
        try {
          body = /** @type {any} */ (await readJsonBody(req));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("exceeds") && message.includes("bytes")) {
            sendJson(res, 413, {
              error: {
                message: "request body too large (max 1 MiB)",
                type: "invalid_request_error"
              }
            });
            return;
          }
          // JSON.parse and req error get bundled here — both are
          // recoverable on the client side, so 400.
          sendJson(res, 400, {
            error: {
              message: `invalid JSON body: ${message}`,
              type: "invalid_request_error"
            }
          });
          return;
        }

        const resolved = resolveModelToBackend(body.model || "");
        if (!resolved) {
          sendJson(res, 400, {
            error: {
              message: `Cannot resolve model "${body.model}" to a backend. Use claude*, codex*, gemini*, or "<backend>:<model-id>".`,
              type: "invalid_request_error"
            }
          });
          return;
        }

        const prompt = flattenMessages(body.messages);
        if (!prompt) {
          sendJson(res, 400, {
            error: {
              message: "messages[] is required and must contain at least one message with content.",
              type: "invalid_request_error"
            }
          });
          return;
        }

        if (body.stream === true) {
          await handleStreamingChatCompletion(req, res, body, resolved, dispatch, prompt);
          return;
        }

        try {
          const turn = await dispatch(resolved.backend, {
            prompt,
            model: resolved.modelOverride,
            timeoutMs: 5 * 60 * 1000
          });
          sendJson(res, 200, turnResultToOpenAiResponse(body.model, turn));
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err !== null && "exitCode" in err
                ? `${resolved.backend} CLI exited ${/** @type {any} */ (err).exitCode}: ${/** @type {any} */ (err).stderr}`
                : String(err);
          sendJson(res, 502, {
            error: {
              message,
              type: "backend_error",
              backend: resolved.backend
            }
          });
        }
        return;
      }

      sendJson(res, 404, {
        error: { message: "not found", type: "invalid_request_error" }
      });
    } catch (err) {
      // Don't leak err.message / err.stack to clients (CodeQL
      // js/stack-trace-exposure). Internal errors here mean a bug or
      // an unexpected request shape; the server-side stderr trace is
      // the right place for the detail.
      try {
        process.stderr.write(
          `openai-facade: server_error ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
        );
      } catch {
        // best-effort
      }
      sendJson(res, 500, {
        error: { message: "internal server error", type: "server_error" }
      });
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
          const address = /** @type {import("node:net").AddressInfo} */ (server.address());
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
    }
  };
}
