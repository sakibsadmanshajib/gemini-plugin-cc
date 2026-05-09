# Streaming runner foundation

## Why

Cross-driver dispatch (claude→gemini, codex→gemini, etc.) currently
spawns a fresh CLI subprocess per turn. Even with the broker-aware
optimization (Phase 0, commit `c086227`) the gemini path still does a
fresh ACP `initialize` + `session/new` round-trip every call. For
high-frequency cross-driver use (review loops, multi-turn rescue
sessions) this wastes 50-200 ms per turn on protocol overhead that
could be amortized.

The streaming-input runner pattern — keep one CLI subprocess open and
multiplex many turns through it — is the documented next step in
`add-unified-acp-server-with-mcp-aggregation`. That bigger change
covers ACP-server + MCP aggregation + per-backend adapters end to end.
This proposal carves out the **runner foundation** as a smaller,
shippable increment so the lifecycle plumbing lands ahead of the
broader server work.

## What changes

Adds three pieces of infrastructure under `lib/runners/streaming/`:

1. **`types.mjs`** — JSDoc contract: `StreamingRunner`,
   `StreamingHealth` ("starting" | "healthy" | "degraded" |
   "restarting" | "dead"), `StreamingTurnOptions`. Per-backend runners
   conform to this; the supervisor and registry are generic over it.

2. **`supervisor.mjs::createSupervisor`** — generic lifecycle wrapper
   around any `StreamingRunner`. Handles:
   - lazy `start()` (the factory is not invoked until the first
     `runTurn`)
   - idle reaping (close the runner after `idleMs` of inactivity)
   - bounded restart on dead-child failures
     (`maxRestarts` / `restartWindowMs`)
   - health-label aggregation
   - exit-safe `close()` (idempotent, no-throw on stale state)

3. **`registry.mjs::getStreamingRunner`** — module-scoped lazy
   supervisor cache keyed by `(backend, cwd)`. First call creates a
   fresh supervisor; subsequent calls return the same instance so the
   underlying CLI subprocess is reused across `runStatelessTurn`
   invocations. Returns `null` for backends without a streaming runner
   wired (CODEX, CLAUDE this iteration).

Plus one concrete backend implementation:

4. **`gemini-streaming.mjs::createGeminiStreamingRunner`** — keeps
   one ACP connection open against the existing `gemini --acp` broker
   for the cwd. `start()` does `initialize` + `session/new` once;
   subsequent `runTurn()` calls reuse the same `sessionId` over
   `session/prompt`. Cost records emit `transport: "acp-server"` so
   observability can distinguish per-turn-broker vs streaming ratios.

Plus the dispatcher hook:

5. **`lib/runners/dispatch.mjs`** gains a new opt-in branch behind
   `useStreaming: true` / `ARTAGON_STREAMING=1`. When opted in and
   the registry returns a runner, the turn goes through the
   streaming path; otherwise it falls through to the existing direct
   /broker / facade dispatch silently. Streaming-runner failures
   trigger a one-shot warning + fall back to direct (same invariant
   as Phase 0/2).

Out of scope (deferred to `add-unified-acp-server-with-mcp-aggregation`):

- `bin/artagon-acp-server.mjs` (the user-facing daemon bin)
- Codex `app-server` translator + streaming runner
- Claude streaming runner (Path A vs Path B verification)
- MCP aggregation across backends
- Adding `@modelcontextprotocol/sdk` /
  `@zed-industries/agent-client-protocol` deps (not required by the
  foundation; the existing acp client + broker probe are enough)

## Impact

### Affected specs

- New capability `streaming-runner-foundation` (this change)

### Affected code

- New files: `lib/runners/streaming/{types,supervisor,gemini-streaming,registry}.mjs`
- New files: `tests/unit/streaming-{supervisor,gemini}.test.mjs`,
  `tests/unit/dispatch-streaming-aware.test.mjs`
- Modified: `lib/runners/dispatch.mjs` (new branch, new env var,
  new warning latch)
- The plugins/<host>/lib/ vendor copies are kept in sync via
  `pnpm vendor:lib`.

### Forward compatibility

The `StreamingRunner` contract is stable; per-backend variants
(codex, claude) can be wired into `registry.mjs::factoryFor` without
touching the supervisor or dispatcher. The `transport: "acp-server"`
cost-record value is the same one
`add-unified-acp-server-with-mcp-aggregation` emits, so the
observability layer doesn't need to learn a new value when the
larger change lands.

### Risk

The streaming runner depends on a live `gemini --acp` broker for the
cwd. If no broker exists, `start()` rejects and the dispatcher falls
back to the direct path silently — no regression vs Phase 0. The
opt-in flag means existing behavior is unchanged for users who don't
set `ARTAGON_STREAMING=1`.
