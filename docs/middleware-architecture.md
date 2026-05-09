# Middleware architecture

Middleware wraps an `AcpSession` to add cross-cutting concerns (redaction, audit, retry, fallback, cache) without each backend re-implementing them. The composition shape mirrors classic Express/Koa middleware: each middleware is `(next: AcpSession) => AcpSession`, and `composeMiddleware([m1, m2, m3])` chains them with m1 outermost.

## Default chain

```
client → redaction → audit → cost → retry → fallback → cache → backend
```

Order matters. The composition machinery validates the redaction-first invariant — anything else throws `MiddlewareOrderError`, in **every** environment. (An earlier revision downgraded the production case to a stderr WARN; that failed-open in exactly the deployment where un-redacted secrets through audit/observability are most damaging, and was reverted.)

## Why the order

**Redaction first** — every other middleware sees only redacted content. Audit logs are safe to ship; retry diagnostics don't leak; cost bookkeeping never references credentials. Violating this is the single most dangerous misconfig possible, hence the hard validation.

**Audit second** — captures the decision flow (request, response, retry attempts, fallback swaps) on disk. Audit positioning after redaction guarantees no secrets land on disk.

**Cost third** — token accounting. Records per-attempt usage; on retry, each attempt is its own record. Implemented at `lib/middleware/cost.mjs` with a pluggable token extractor that handles three known result shapes: Codex/Claude `usage.input_tokens`/`output_tokens` and Gemini `usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}`. Tracks `prompts`/`toolCalls`/`errors` counts plus cumulative `tokens.{input,output,total}`. Cost numbers are non-authoritative — billing console is the source of truth; cost middleware exists for in-session feedback ("am I racking up tokens?") and trend analysis.

**Retry fourth** — transparently re-tries transient failures. Audit/cost see each attempt; backend sees only the resilient view.

**Fallback fifth** — when retry exhausts, swap to the next model. Independent from retry: retry handles "same model, transient blip"; fallback handles "this model can't right now."

**Cache sixth** — opt-in via `_cache: true`. Cache hits short-circuit BEFORE the backend sees the request, so retry/fallback/cost don't fire for cached results. This is intentional — a cached result is a known-good answer; double-charging or re-retrying is wrong.

## Per-middleware contract summary

| Middleware | Position | Reads                                                  | Writes                                                                 | Failure mode                                   |
| ---------- | -------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------- |
| redaction  | 0        | request params, notification params                    | replaces secret patterns with `[redacted]`                             | never throws (transformation always succeeds)  |
| audit      | ≥1       | every method call                                      | append-only JSONL under `~/.acp-plugins/audit/<sessionId>/audit.jsonl` | swallows errors; logs disabled-state to stderr |
| cost       | ≥1       | `session/prompt` requests, results, `tool_call` notifs | in-memory `record()` snapshot; optional `onUpdate(record)` callback    | swallows extractor errors; counts marked 0     |
| retry      | ≥1       | thrown errors from `next.request`                      | nothing                                                                | re-raises the last error after max attempts    |
| fallback   | ≥1       | thrown errors with overload signal                     | nothing                                                                | re-raises if chain exhausts                    |
| cache      | last     | request method + params + git HEAD                     | `~/.acp-plugins/cache/<sha256>.json`                                   | best-effort; swallows IO errors                |

## When to add a new middleware

Plumb it into `composeMiddleware` if the concern is cross-cutting (applies to ≥2 backends). Implement it as a backend-specific helper if it's narrow. The order question is decided by the data flow — what does this middleware need to see, and what does it produce that other middlewares might need to see?

```js
import { composeMiddleware } from "../lib/middleware/compose.mjs";
import { createRedactionMiddleware } from "../lib/middleware/redaction.mjs";
// ...

const chain = composeMiddleware([
  createRedactionMiddleware(),
  createAuditMiddleware({ sessionId }),
  createCostMiddleware({ sessionId, onUpdate: (rec) => liveCostDisplay(rec) }),
  createRetryMiddleware({ maxAttempts: 3 }),
  createFallbackMiddleware(),
  createCacheMiddleware(),
]);

const wrapped = chain(createAcpClient(transport));
```

## Testing middlewares

`tests/unit/middleware.test.mjs` exercises each middleware in isolation plus the e2e composed chain. The pattern:

1. **Unit test the middleware in isolation** — wrap a handcrafted `next` object that exposes the methods the middleware calls. No real transport needed.
2. **Property-test where the contract is invariant** — redaction has a property test asserting "any text containing a known secret produces text without that secret after redaction."
3. **E2E composed test** — wrap MockBackend with the full chain and assert that requests round-trip with redaction applied, audit log empty (when disabled), and no observable behavior change.

## Slash-command toggles (planned)

Per the proposal, slash commands honor:

- `--no-retry` — disable retry for this call
- `--no-fallback` — disable fallback for this call
- `--cache` / `--no-cache` — opt in/out of cache

Wiring at the slash-command layer is part of `add-middleware-and-release` T8.3 (planned, not yet implemented).
