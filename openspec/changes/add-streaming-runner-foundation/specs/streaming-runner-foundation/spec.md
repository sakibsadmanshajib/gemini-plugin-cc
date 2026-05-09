# streaming-runner-foundation

Generic per-backend long-lived runner pattern: keep one CLI subprocess
open and multiplex multiple turns through it. The foundation is the
contract + supervisor + registry + one concrete backend (gemini); per-
backend variants for codex/claude land in
`add-unified-acp-server-with-mcp-aggregation`.

## ADDED Requirements

### Requirement: Streaming runner contract

The suite SHALL define a JSDoc-typed `StreamingRunner` interface at
`lib/runners/streaming/types.mjs` with four methods: `start()`,
`runTurn(options)`, `close()`, and `health()`. Health labels MUST be
restricted to "starting" | "healthy" | "degraded" | "restarting" |
"dead" so observability tooling can rely on a fixed enumeration.

#### Scenario: Health label enumeration is closed

- **GIVEN** a streaming runner implementation
- **WHEN** `runner.health()` is called at any lifecycle point
- **THEN** the return value is one of the five enum values above

#### Scenario: Lifecycle invariants

- **GIVEN** a streaming runner that has never been started
- **WHEN** `runner.close()` is called
- **THEN** the call resolves without throwing AND no underlying
  subprocess is spawned

- **GIVEN** a streaming runner whose `close()` already returned
- **WHEN** `runner.close()` is called again
- **THEN** the call resolves without throwing AND no double-close
  side-effects fire (no second subprocess kill, no second transport
  destroy)

### Requirement: Supervisor lifecycle

The supervisor SHALL wrap any `StreamingRunner` and own its lifecycle, and the supervisor itself MUST conform to `StreamingRunner`. The factory provided to the supervisor MUST NOT be invoked until the first `start()` or `runTurn()` call so that module-load-time imports do not spawn subprocesses. The supervisor lives at `lib/runners/streaming/supervisor.mjs::createSupervisor`.

#### Scenario: Lazy start

- **GIVEN** a fresh supervisor wrapping a runner factory
- **WHEN** the supervisor is constructed but no methods are called
- **THEN** the factory is not invoked AND no underlying runner exists

#### Scenario: Idle reap

- **GIVEN** a supervisor with `idleMs: N` and a started underlying runner
- **WHEN** N+1 milliseconds elapse with no `runTurn()` calls
- **THEN** the supervisor calls `close()` on the underlying runner AND
  the next `runTurn()` invokes the factory afresh

#### Scenario: Idle timer reset on success

- **GIVEN** a supervisor with `idleMs: 10000` after a successful turn
- **WHEN** another `runTurn()` succeeds at t=7s and another t=14s later
- **THEN** the runner is still alive at t=21s (each success resets the
  timer)

#### Scenario: Bounded restart on dead-child failure

- **GIVEN** a supervisor with `maxRestarts: N` and `restartWindowMs: W`
- **WHEN** the underlying runner reports `health() === "dead"` more
  than N times within W milliseconds
- **THEN** the supervisor declares itself `health() === "dead"` AND
  rejects subsequent `runTurn()` calls with an "exceeded N restarts"
  message

### Requirement: Registry singleton-per-(backend,cwd)

The registry SHALL return the same supervisor instance for repeat calls with the same `(backend, cwd)` tuple, and different cwds MUST get different supervisors so per-project state never crosses project boundaries. The registry lives at `lib/runners/streaming/registry.mjs::getStreamingRunner`.

#### Scenario: Same key returns same instance

- **GIVEN** the registry is empty
- **WHEN** `getStreamingRunner(GEMINI, { cwd: "/a" })` is called twice
- **THEN** both calls return the identical supervisor instance

#### Scenario: Different cwd yields different instance

- **GIVEN** a supervisor cached for `(GEMINI, "/a")`
- **WHEN** `getStreamingRunner(GEMINI, { cwd: "/b" })` is called
- **THEN** the registry creates AND returns a new supervisor distinct
  from the `(GEMINI, "/a")` instance

#### Scenario: Unsupported backend returns null

- **GIVEN** a backend without a streaming runner factory wired
  (CLAUDE or CODEX as of this change)
- **WHEN** `getStreamingRunner(<unsupported>, opts)` is called
- **THEN** the registry returns `null` (NOT a partially-constructed
  supervisor) so callers can fall back cleanly

### Requirement: Gemini streaming runner

The gemini streaming runner SHALL connect to a live `gemini --acp` broker for the cwd via `findActiveBroker` and reuse one ACP `sessionId` for every `runTurn` call until close. The runner MUST emit `transport: "acp-server"` in its cost records so the streaming path is distinguishable from per-turn-broker (`"broker"`) and cold-start (`"cli"`) calls. The runner lives at `lib/runners/streaming/gemini-streaming.mjs::createGeminiStreamingRunner`.

#### Scenario: No broker means clean failure

- **GIVEN** no live broker exists for the cwd
- **WHEN** `start()` is called on the runner
- **THEN** `start()` rejects with a message containing "no live broker"
  AND `health()` returns "dead" AND no subprocess is spawned

#### Scenario: One handshake serves many turns

- **GIVEN** a started gemini streaming runner
- **WHEN** `runTurn` is called three times in succession
- **THEN** the broker sees exactly one `initialize` request AND exactly
  one `session/new` request AND three `session/prompt` requests carrying
  the same `sessionId`

#### Scenario: Cost record transport label

- **GIVEN** a successful `runTurn` on the gemini streaming runner
- **WHEN** the cost recorder appends the record
- **THEN** the record's `transport` field equals `"acp-server"`

#### Scenario: Degraded vs dead health labels

- **GIVEN** a `runTurn` call that rejects but the underlying transport
  reports `isOpen() === true`
- **WHEN** `health()` is queried after the rejection
- **THEN** the returned label is `"degraded"` (caller may retry without
  full restart)

- **GIVEN** a `runTurn` call that rejects and the underlying transport
  reports `isOpen() === false`
- **WHEN** `health()` is queried after the rejection
- **THEN** the returned label is `"dead"` (supervisor must restart)

### Requirement: Dispatcher streaming branch

The dispatcher (`lib/runners/dispatch.mjs::runStatelessTurn`) SHALL
consult the streaming registry when one of two opt-in signals is set:
`options.useStreaming === true` OR `process.env.ARTAGON_STREAMING ===
"1"`. The opt-in MUST be vetoable via `options.disableStreaming === true`
so benchmark / regression-test callers can force the direct path. Without
opt-in, no streaming code path is exercised — the dispatcher behaves
exactly as it did before this change.

#### Scenario: Opt-out by default

- **GIVEN** neither `useStreaming` nor `ARTAGON_STREAMING=1` is set
- **WHEN** `runStatelessTurn(GEMINI, options)` is called
- **THEN** the registry is NOT consulted AND the call goes through the
  pre-existing direct/broker dispatch path

#### Scenario: Veto wins over env opt-in

- **GIVEN** `ARTAGON_STREAMING=1` is set in the environment
- **WHEN** `runStatelessTurn(GEMINI, { disableStreaming: true })` is
  called
- **THEN** the registry is NOT consulted

#### Scenario: Null runner falls through silently

- **GIVEN** the registry returns `null` for the requested backend (no
  streaming variant wired)
- **WHEN** the streaming branch handles the call
- **THEN** the dispatcher falls through to the direct path AND emits
  no warning to stderr (this is normal, not an error)

### Requirement: Streaming fallback never blocks the user

The dispatcher SHALL fall back to the direct path on any streaming-runner
error. The fallback MUST be silent on the second and subsequent failures
within the same process — only the first streaming failure prints a
single one-line warning to stderr, identifying the failure mode and
declaring that subsequent fallbacks will be silent.

#### Scenario: First failure prints exactly one warning

- **GIVEN** the streaming runner's `runTurn` rejects with `Error("X")`
- **WHEN** the dispatcher handles the failure
- **THEN** stderr receives exactly one line containing
  `[dispatch] streaming runner failed (X)` AND the call falls back to
  the direct path AND the direct path's `TurnResult` is returned to
  the caller

#### Scenario: Subsequent failures are silent

- **GIVEN** the streaming runner has already failed once this process
- **WHEN** the runner fails N more times in subsequent calls
- **THEN** stderr receives no additional `[dispatch] streaming runner
failed` lines AND each call still falls back successfully
