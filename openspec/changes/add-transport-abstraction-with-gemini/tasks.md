# Tasks: add-transport-abstraction-with-gemini

## 1. ACP core types and framing

- [ ] T1.1 — Create `lib/acp/types.mjs` with JSDoc types:
  `AcpSession`, `JsonRpcRequest`, `JsonRpcResponse`,
  `JsonRpcNotification`, `SessionUpdate`, `PermissionRequest`,
  `PermissionResponse`, `HealthState`
- [ ] T1.2 — Create `lib/acp/framing.mjs`:
  - `parseLines(buffer)` → iterable of parsed JSON objects
  - `frame(msg)` → string with trailing newline
  - handles partial-line buffering across reads
- [ ] T1.3 — Create `lib/acp/client.mjs` — generic ACP client built on
  any transport. Methods: `request(method, params)`, `notify(method, params)`,
  event emitters for incoming notifications
- [ ] T1.4 — Property tests for `framing.mjs` exercising malformed
  input, partial buffers, unicode, large payloads
- [ ] T1.5 — Unit tests for `client.mjs` using in-memory transport

## 2. CliTransport

- [ ] T2.1 — Create `lib/transport/cli.mjs`:
  ```
  createCliTransport({ command, args, env, cwd, healthCheckInterval })
    → AcpSession
  ```
- [ ] T2.2 — Subprocess spawn with stdio piped; stderr piped to logger
- [ ] T2.3 — Outbound writes via `proc.stdin.write(frame(msg))`; inbound
  via `readline` on stdout
- [ ] T2.4 — Graceful shutdown: SIGTERM, wait 5s, SIGKILL fallback
- [ ] T2.5 — Crash detection: emit `health: 'worker_missing'` on
  unexpected exit
- [ ] T2.6 — Health-label tracking: heartbeat detection, transition
  timing, integration with logger and OTel from previous change
- [ ] T2.7 — Conformance test suite (see T5)
- [ ] T2.8 — Subprocess lifecycle tests using fake binaries from previous
  change

## 3. MockBackend reference implementation

- [ ] T3.1 — Create `lib/test-utils/mock-backend.mjs`:
  - implements `AcpSession`
  - scriptable: tests configure expected prompts and responses
  - records all interactions for assertions
- [ ] T3.2 — Use `MockBackend` to validate that the conformance suite is
  not transport-specific
- [ ] T3.3 — Document `MockBackend` as the reference for future backend
  implementors in `docs/architecture.md`

## 4. Gemini backend declaration

- [ ] T4.1 — Create `lib/backends/gemini.mjs`:
  ```
  export const geminiBackend = {
    name: 'gemini',
    modelAliases: { pro: 'gemini-3.1-pro-preview', flash: '...', ... },
    transports: {
      cli: (config) => createCliTransport({ command: 'gemini', args: ['--acp'], env: ... })
    },
    defaultTransport: 'cli',
    setupHints: { authCommand: '!gemini', envVar: 'GEMINI_API_KEY' }
  }
  ```
- [ ] T4.2 — Migration: existing Gemini-specific logic from
  `gemini-companion.mjs` either moves to `lib/backends/gemini.mjs` or
  to the plugin shell; companion becomes a thin orchestrator
- [ ] T4.3 — Existing Gemini-specific health interpretation (rate-limit
  parsing, auth-error detection) lives in `lib/backends/gemini.mjs`
  hooks called by `CliTransport`

## 5. Conformance test suite

- [ ] T5.1 — Create `lib/test-utils/conformance.mjs` exporting
  `runConformanceSuite(name, factory)` — runs a fixed set of tests
  against any object claiming to implement `AcpSession`
- [ ] T5.2 — Tests cover:
  - session/new returns sessionId
  - prompt sends + receives session/update notifications
  - cancel mid-prompt halts the session
  - close releases resources idempotently
  - permission requests round-trip correctly
  - health transitions are observable
- [ ] T5.3 — Apply suite to `MockBackend` (must pass)
- [ ] T5.4 — Apply suite to `CliTransport` with fake-gemini binary
  (must pass)
- [ ] T5.5 — Apply suite to `geminiBackend.transports.cli(...)` (must pass)

## 6. State schema versioning

- [ ] T6.1 — Update job state file format: top-level
  `{ schemaVersion: '2', ... }`
- [ ] T6.2 — `lib/state/migrate.mjs`: reads any version, returns latest;
  v1 → v2 migration is field-additive only (no removed fields)
- [ ] T6.3 — Test: write a v1 state file, read it under v2 code, verify
  contents
- [ ] T6.4 — Document schema in `docs/state-schema.md`

## 7. Companion CLI integration

- [ ] T7.1 — Refactor `gemini-companion.mjs` to use
  `geminiBackend.transports.cli(...)` instead of direct
  `acp-broker.mjs` calls
- [ ] T7.2 — Slash command behavior unchanged (verified by integration
  tests)
- [ ] T7.3 — Wire log hooked into `CliTransport` read/write
- [ ] T7.4 — OTel spans for `session/new`, `session/cancel`, tool calls
  emitted from `CliTransport`

## 8. Equivalence verification

- [ ] T8.1 — Capture wire log from current main branch on at least 3
  representative scenarios (review, rescue, cancel)
- [ ] T8.2 — Convert wire logs to fixtures (using script from previous
  change)
- [ ] T8.3 — Replay each fixture against the new `CliTransport` + mock
  upstream that emits the recorded responses
- [ ] T8.4 — Assert outbound messages from new implementation match the
  wire log's outbound (modulo timestamps and request IDs)

## 9. Documentation

- [ ] T9.1 — `docs/architecture.md` — overview diagram, layer
  responsibilities, where to add new transports/backends
- [ ] T9.2 — `docs/transport-cli.md` — CliTransport configuration
  reference
- [ ] T9.3 — Update CONTRIBUTING with new file layout

## 10. Verification

- [ ] T10.1 — All conformance tests pass for MockBackend, CliTransport
  with fake binaries, and geminiBackend
- [ ] T10.2 — All existing Gemini integration tests pass unchanged
- [ ] T10.3 — Equivalence verification (T8) passes
- [ ] T10.4 — Mutation score on `lib/acp/` and `lib/transport/cli.mjs`
  ≥ 75% (higher than baseline because protocol code is critical)
- [ ] T10.5 — At least 2 PRs reviewed via `/codex:adversarial-review`

## Acceptance

- [ ] All tasks complete
- [ ] CI green
- [ ] No user-visible behavior change for `/gemini:*` commands
- [ ] `MockBackend` is a complete reference: documented as "implement
  this interface" example
- [ ] State schema migration tested and documented
