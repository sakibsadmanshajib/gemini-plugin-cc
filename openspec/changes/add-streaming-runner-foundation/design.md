# Design

## Layering

```
runStatelessTurn(backend, opts)
   │
   ├── shouldUseFacade(opts)  ─── Phase 2 (opt-in: useFacade / ARTAGON_USE_FACADE=1)
   │
   ├── shouldUseStreaming(opts) ── Phase 3 (this change; opt-in: useStreaming / ARTAGON_STREAMING=1)
   │     │
   │     └── getStreamingRunner(backend, { cwd, env })
   │           │
   │           └── createSupervisor({ factory, idleMs, maxRestarts, restartWindowMs })
   │                 │
   │                 └── factory() → createGeminiStreamingRunner({ probe, createTransport, createClient })
   │                                  ├── start():  initialize + session/new (once)
   │                                  ├── runTurn(): session/prompt (many)
   │                                  └── close(): tear down
   │
   └── runDirect(backend, opts) ─── existing path (broker-aware for GEMINI, cold-start for CLAUDE/CODEX)
```

Three opt-in signals are independent: facade and streaming can be
combined ("try facade, on fail try streaming, on fail go direct") in
future work, but in this change facade preempts streaming since
`shouldUseFacade` is checked first. The current dispatcher does not
combine them — each opt-in is a separate top-level branch.

## Why a registry

`getStreamingRunner` returns the same supervisor for repeat calls
with the same `(backend, cwd)`. Without this caching, every
`runStatelessTurn` would create a fresh supervisor + run start() +
spawn a fresh subprocess, defeating the entire purpose of streaming.

The registry's key is `${backend}::${cwd}`. We deliberately do NOT
key on `env` (would create leaks if a caller passed a fresh env each
time) or on `model` (the per-turn model is sent via `runTurn` opts,
not handshake).

## Why a separate supervisor

The supervisor's job is "lifecycle for any StreamingRunner." Per-
backend runners (gemini, codex, claude) all need:

1. lazy start (so module imports don't spawn processes)
2. idle reap (so an unused warm runner doesn't pin a CLI subprocess
   forever)
3. restart on dead-child failures (so a crashed subprocess doesn't
   poison the whole supervisor)
4. health labels (so observability can answer "is X warm?")

Putting this in each backend's runner = three copies of the same
state machine. Putting it in the supervisor + a thin per-backend
runner is one copy of the state machine + three protocol drivers.

## Failure modes

| Failure                        | Detection                        | Recovery                            |
| ------------------------------ | -------------------------------- | ----------------------------------- |
| No live broker for cwd         | gemini-streaming start() rejects | Dispatcher falls back to direct     |
| Broker dies mid-session        | runner.health() → "dead"         | Supervisor restarts (within budget) |
| Slow turn (network, model lag) | turn-level timeout in runner     | Reject; runner stays "degraded"     |
| Repeated dead-child crashes    | restart counter > maxRestarts    | Supervisor → "dead", rejects calls  |
| Idle period exceeds idleMs     | idle timer fires                 | Runner closed; next call restarts   |

The "broken warm path MUST NOT block the user" invariant from
Phase 0/2 carries forward: any error inside the streaming branch
falls back to the direct path with a one-shot stderr warning.

## Why no `bin/artagon-acp-server.mjs` here

That bin is the user-visible piece of
`add-unified-acp-server-with-mcp-aggregation`. It will REUSE the
supervisor + registry + per-backend runners shipped here, so this
change is its prerequisite — but the bin itself (with commander
flags, --listen, --backend, --idle-ms, etc.) belongs in the larger
spec. Carving it out keeps this change small enough to land in one
session.

## Test strategy

- **Supervisor tests** use a `FakeRunner` driven by a state object
  so every transition (lazy start, idle reap, restart-budget,
  dead-state) is deterministic without touching processes/sockets.
  Vitest fake timers drive idle-reap timing.
- **Gemini-streaming tests** use a fake ACP client whose `request`
  method is a queue of canned responses, and a fake transport with a
  `_kill()` test hook to simulate broker death mid-turn. No real
  socket or subprocess.
- **Dispatcher tests** mock `getStreamingRunner` directly so the test
  asserts which path the dispatcher took without exercising the
  whole stack.

This mirrors the test strategy already used for the broker-probe and
facade tests (Phase 0 and Phase 2): unit-level, deterministic, no
real I/O. Integration coverage with a real `gemini --acp` broker is
out of scope for this change — it lands when
`add-unified-acp-server-with-mcp-aggregation` ships its end-to-end
acceptance suite.

## Migration

None. The streaming branch is opt-in via a new flag and a new env
var. Existing callers that don't set either flag see byte-identical
behavior.
