# OpenAI Chat Completions facade

`lib/server/openai-facade.mjs` exposes an OpenAI-API-compatible HTTP
endpoint in front of the multi-backend CLIs. Any tool that already
speaks OpenAI's Chat Completions API can target this server and route
to Claude, Codex, or Gemini behind the scenes.

Run it with:

```sh
artagon-openai-server --port 3000
# or programmatically:
import { createOpenAiFacadeServer } from "artagon-agent-cli-plugin/lib/server/openai-facade.mjs";
const facade = createOpenAiFacadeServer({ port: 3000 });
await facade.listen();
```

## Endpoints

| Method  | Path                   | Auth required? | Description                                            |
| ------- | ---------------------- | -------------- | ------------------------------------------------------ |
| GET     | `/health`              | no             | Liveness probe — always 200                            |
| GET     | `/admin/status`        | yes (when set) | Per-supervisor health + SQLite stats snapshot          |
| GET     | `/v1/models`           | yes (when set) | OpenAI list shape; per-backend canonical ids + aliases |
| GET     | `/v1/models/{id}`      | yes (when set) | Single-model retrieval; 404 on unknown                 |
| POST    | `/v1/chat/completions` | yes (when set) | Standard OpenAI request → backend dispatch             |
| OPTIONS | (any)                  | n/a            | CORS preflight when enabled; 405 otherwise             |

`/health` is intentionally exempt from API-key auth so load
balancers can probe without credentials (matches OpenAI's pattern).

### `/admin/status`

Operator-facing snapshot. Uses the same bearer auth as `/v1/*`. Body:

```json
{
  "pid": 4321,
  "startedAt": "2026-05-11T19:00:00.000Z",
  "uptimeMs": 1230456,
  "supervisors": [
    { "backend": "claude", "health": "healthy", "lastError": null },
    { "backend": "codex", "health": "dead", "lastError": "auth_failed" }
  ],
  "stats": {
    "sqlitePath": "/Users/me/.local/state/artagon-agent-cli-plugin/stats.db",
    "failureCount": 0,
    "lastWarnedAt": null
  },
  "auth": { "required": true }
}
```

`supervisors` is empty until the first chat-completions request lazily
constructs a supervisor for that backend.

`health` is one of `starting | healthy | degraded | restarting | dead`
(see `StreamingHealth` in `lib/runners/streaming/types.mjs`).

`lastError` is a redacted enum code or `null`. The closed set is the
`LastErrorCode` union in `types.mjs`:

| Code                       | Meaning                                              |
| -------------------------- | ---------------------------------------------------- |
| `spawn_not_found`          | CLI bin missing on PATH (`ENOENT`)                   |
| `spawn_denied`             | Permission failure starting the CLI (`EACCES/EPERM`) |
| `timeout`                  | Operation timed out / `ETIMEDOUT`                    |
| `auth_failed`              | 401/403, expired login, unauthorized                 |
| `transport_closed`         | stdio pipe closed, EPIPE, non-zero exit, ECONNRESET  |
| `restart_budget_exhausted` | Supervisor declared dead after too many restarts     |
| `session_init_failed`      | `session/new` / `thread/start` returned no id        |
| `internal_error`           | Our own invariants tripped (`runTurn before start`)  |
| `introspect_failed`        | Supervisor object itself threw during introspection  |
| `oom`                      | Out of memory / `ENOMEM`                             |
| `unknown`                  | Unclassified runner error — check daemon stderr      |

The full error message stays in the daemon's stderr log. The redaction
is intentional: `/admin/status` is reachable without a bearer when
`--api-key` is unset, and raw error strings can contain filesystem
paths or auth hints. New codes require updating both the union in
`types.mjs` AND this table.

## Backend routing — `model` field

The OpenAI request's `model` field selects the backend:

| Pattern                        | → Backend | Examples                                             |
| ------------------------------ | --------- | ---------------------------------------------------- |
| `claude*`                      | claude    | `claude`, `claude-sonnet-4-6`, `claude-opus-4-7`     |
| `sonnet*` / `opus*` / `haiku*` | claude    | `sonnet`, `opus`, `haiku`                            |
| `codex*`                       | codex     | `codex`, `codex-cli-1`                               |
| `gpt-5*`                       | codex     | `gpt-5`, `gpt-5-codex`                               |
| `o3*` / `o4*`                  | codex     | `o3`, `o4-mini`                                      |
| `spark`                        | codex     | exact match                                          |
| `gemini*`                      | gemini    | `gemini`, `gemini-2.5-pro`, `gemini-3-flash-preview` |
| `auto-gemini*`                 | gemini    | `auto-gemini-3`                                      |
| `<backend>:<model-id>`         | explicit  | `claude:opus-4-7`, `codex:gpt-5-codex`               |

Unknown patterns return **400 invalid_request_error** with a hint at
the supported families.

## Request body shape

```ts
type ChatRequest = {
  model: string; // required
  messages: Array<{
    // required
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }>;
  stream?: boolean; // default false; SSE when true
  stream_options?: {
    include_usage?: boolean; // emit usage chunk before [DONE]
  };
  n?: 1; // n != 1 is rejected (see "Limits")
  // temperature / max_tokens / top_p accepted but ignored —
  // each runner's CLI uses its own defaults
};
```

`messages[]` is collapsed into a single concatenated prompt with role
headers (`User: ...`, `System: ...`, `Assistant: ...`). The runners
are stateless one-shot; full multi-turn requires session continuity
on the underlying CLI side which isn't yet wired through.

## Streaming

`stream: true` switches to Server-Sent Events. Wire format:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"...","choices":[{"delta":{"content":"Hello, "},"finish_reason":null}]}

data: {"id":"...","choices":[{"delta":{"content":"world."},"finish_reason":null}]}

data: {"id":"...","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

With `stream_options: { include_usage: true }` an extra chunk lands
between the final delta and `[DONE]`:

```
data: {"id":"...","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49}}

data: [DONE]
```

Client disconnects propagate to the runner via AbortSignal — the
spawned CLI is SIGTERMed instead of running to its 5-min timeout.

## finish_reason mapping

Each backend speaks its own dialect; the facade translates to
OpenAI's canonical set:

| Backend reason                                                | → Mapped         |
| ------------------------------------------------------------- | ---------------- |
| `stop`, `STOP`, `end_turn`, `stop_sequence`, anything unknown | `stop`           |
| `length`, `max_tokens`, `MAX_TOKENS`, `error_max_turns`       | `length`         |
| `content_filter`, `SAFETY`, `RECITATION`                      | `content_filter` |
| `tool_use`, `tool_calls`                                      | `tool_calls`     |
| `function_call`                                               | `function_call`  |

Without this mapping, OpenAI clients writing
`if reason == "length"` retry branches would silently miss Claude's
`max_tokens` or Gemini's uppercase `MAX_TOKENS`.

## Error responses

All errors follow OpenAI's shape:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "code": "...",
    "param": "...",
    "backend": "..."
  }
}
```

| HTTP | `type`                  | When                                                                                                                |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_request_error` | Unknown model, missing messages, n != 1, bad JSON                                                                   |
| 401  | `invalid_request_error` | Missing/invalid bearer token (when `--api-key` set)                                                                 |
| 404  | `invalid_request_error` | Unknown URL or unknown model id under `/v1/models/{id}`                                                             |
| 405  | n/a                     | OPTIONS without CORS enabled                                                                                        |
| 413  | `invalid_request_error` | Body > 1 MiB                                                                                                        |
| 500  | `server_error`          | Unexpected internal failure (detail goes to stderr; client gets a generic message)                                  |
| 502  | `backend_error`         | Underlying CLI failed (detail goes to stderr; client gets `<backend> backend failed; check server logs for detail`) |

## Authentication — `--api-key`

By default the facade does **not** authenticate; the loopback bind
makes that low-risk. Pass `--api-key sk-...` (or
`$ARTAGON_FACADE_API_KEY`, or `--api-key-file <path>`) to require:

```
Authorization: Bearer <key>
```

on every `/v1/*` request. `/health` is exempt. Keys are
constant-time-compared via `crypto.timingSafeEqual` to prevent
char-by-char timing-leak attacks.

```sh
# Single key
artagon-openai-server --api-key sk-test --port 3000

# Multi-key allowlist (rotation)
artagon-openai-server --api-key sk-old,sk-new --port 3000

# Read from file (preferred — key not visible in `ps -ef`)
artagon-openai-server --api-key-file ~/.config/artagon/api-key
```

## CORS — `--cors`

Default off (browsers can't reach the loopback server). Enable when
calling from a browser-based client:

```sh
# Wildcard (least secure)
artagon-openai-server --cors '*' --port 3000

# Single origin
artagon-openai-server --cors http://localhost:3000

# Multi-origin allowlist
artagon-openai-server --cors http://a.test,http://b.test
```

OPTIONS preflight returns 204 with `Access-Control-Allow-{Methods,Headers}`
when the origin is permitted, 405 otherwise. Every response under an
allowed origin gets `Access-Control-Allow-Origin` (echoed origin or
`*`) plus `Vary: Origin`.

`$ARTAGON_FACADE_CORS` env counterpart: `1`/`true`/`*` for wildcard,
otherwise comma-separated allowlist.

## Limits

- **Body size**: 1 MiB. Larger requests get 413.
- **`n != 1`**: rejected with 400 `param: "n"`. The runners produce
  one completion per turn; clients indexing `choices[1..n-1]` would
  see undefined.
- **Tool calls / function calls**: not supported in the OpenAI shape
  yet. The runners produce ACP `tool_call` updates internally but
  mapping them to OpenAI's `tool_calls` response shape is deferred.
- **Multi-turn conversations**: `messages[]` is flattened, not
  threaded. The runners are stateless one-shot.

## Library use vs. CLI

The library exposes the same server constructor:

```js
import { createOpenAiFacadeServer } from "artagon-agent-cli-plugin/lib/server/openai-facade.mjs";

const facade = createOpenAiFacadeServer({
  port: 3000,
  host: "127.0.0.1",
  cors: "*",
  apiKey: ["sk-prod", "sk-rotation"],
  dispatch: customDispatch, // optional: inject your own runner
});

await facade.listen();
// ...
await facade.close();
```

`dispatch` defaults to `runStatelessTurn` from
`lib/runners/dispatch.mjs`. Inject your own when testing or wiring
the facade in front of a different runner.

## See also

- [`docs/runners.md`](./runners.md) — the underlying runner contract
- [`docs/observability.md`](./observability.md) — cost log integration
- [`SECURITY.md`](../SECURITY.md) — vulnerability disclosure policy
- `tests/integration/openai-facade.test.mjs` — covers every
  endpoint (`/health`, `/v1/models`, `/v1/models/{id}`,
  `/v1/chat/completions`), error paths (unknown model, invalid
  body, oversized body, dispatch failure, n!=1), CORS preflight,
  auth gate (single key, multi-key allowlist, file-based key),
  and streaming shape (SSE chunk format + `stream_options.include_usage`)
