# Add Transport Abstraction with Gemini

## Why

The current plugin's protocol code is tightly coupled to the Gemini CLI
subprocess: spawn args, JSON-RPC framing, broker socket, and Gemini-
specific session handling are intertwined in `acp-broker.mjs` and
`acp-client.mjs`. Adding Codex or Claude requires either copying this code
(three diverging implementations) or refactoring it under load (Stage 2's
big-bang risk).

This change introduces the `AcpSession` interface and the `CliTransport`
implementation, then wires Gemini as the first backend through the
abstraction. End-to-end Gemini behavior is preserved; the plumbing
changes underneath. By the end of this change, the abstraction is proven
against one real backend, and adding more backends in subsequent changes
is "implement the same interface."

## What Changes

- **`lib/acp/`** — generic ACP primitives:
  - `types.mjs` — JSDoc-typed interfaces (`AcpSession`, `JsonRpcMessage`,
    `SessionUpdate`, `PermissionRequest`, etc.)
  - `framing.mjs` — JSON-RPC line framing (newline-delimited)
  - `client.mjs` — generic ACP client building on a transport
- **`lib/transport/cli.mjs`** — `createCliTransport({ command, args, env })`
  factory returning an object conforming to `AcpSession`. Encapsulates:
  - subprocess spawn lifecycle (start, kill SIGTERM → SIGKILL after 5s)
  - stdout JSON-RPC parsing
  - stderr capture to logger
  - heartbeat / health-label tracking
  - crash detection
- **`lib/backends/gemini.mjs`** — Gemini backend declaration:
  - exports `geminiBackend` with `name`, `modelAliases`,
    `transports: { cli: createGeminiCliTransport }`
  - `createGeminiCliTransport(config)` calls `createCliTransport` with
    `command: 'gemini'`, `args: ['--acp']`, env handling for
    `GEMINI_API_KEY`
- **`lib/test-utils/mock-backend.mjs`** — `MockBackend` reference
  implementation conforming to `AcpSession` for use in tests and as
  conformance reference for future backends.
- **Conformance test suite** — a single suite that all `AcpSession`
  implementations (transports + mock + future backends) pass. Tests
  session lifecycle, prompt round-trips, cancellation, error handling,
  health transitions.
- **State schema versioning** — job-state files include `schemaVersion`
  field; v1 reads v1 state, v2 reads v1 and v2; cross-version
  compatibility test added.

## Impact

- **Affected specs**: introduces `acp-core`, `transport-cli`, `backend-gemini`.
- **Affected code**: significant. `acp-broker.mjs` and `acp-client.mjs`
  refactored into `lib/acp/client.mjs` + `lib/transport/cli.mjs`.
  Gemini-specific code moves to `lib/backends/gemini.mjs`. Companion
  CLI (`gemini-companion.mjs`) updates to use the new layer, but slash
  commands and user-facing behavior unchanged.
- **Behavior**: invariant. Every existing `/gemini:*` command works
  identically. Job state files still read/write at same paths.
- **Performance**: invariant or improved (fewer indirection layers).

## Dependencies

- `modernize-toolchain` archived (pnpm, Biome, vitest, types).
- `add-testing-and-observability` archived (test harness, logger, wire
  log).

## Risks and Mitigations

- **Refactor breaks behavior**: ACP test harness from previous change
  catches this. Plus: existing fixture files (recorded from real Gemini
  sessions) are replayed against both old and new implementations to
  confirm equivalence.
- **Health label state machine moves**: existing tests must continue to
  pass; new tests added for transitions through `CliTransport`.
- **State schema migration**: v1 readers must tolerate v2 fields
  (additive only, no removed fields in v2).

## Estimated Effort

3 weeks one engineer (3.5 buffered). Earlier "1.5 weeks with LLM"
floor was unrealistic given the integration-test surface: framing
edge cases, env filtering, PATH resolution, SIGTERM grace tuning,
backpressure, warmup-paused heartbeat, state schema versioning,
MockBackend, and conformance suite design across CliTransport and
MockBackend implementations. LLM helps with code generation, not
with debugging fast-check edge cases or subprocess race conditions.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
