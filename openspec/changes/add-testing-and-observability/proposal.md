# Add Testing and Observability

## Why

The repo currently has minimal tests (a `test.sh` shell script) and no
structured logging, no wire-level capture of JSON-RPC traffic, no
distributed tracing. ACP adapter code — JSON-RPC framing, brokers, job
state, lifecycle handling — is exactly the code where bugs hide and
reproductions are hard. Without testing infrastructure, every change
afterward is a regression risk; without observability, every reported bug
takes hours to reproduce.

This change establishes the test harness and observability stack that all
subsequent changes assume. It consolidates what would have been two
separate phases because they share infrastructure: the wire log format is
the same as the test fixture format, and traces must be correlatable with
log lines.

## What Changes

- **vitest** as the test runner. Replaces `test.sh`. ESM-native, parallel
  by default, snapshot support, `vi.useFakeTimers()` for time-sensitive
  tests.
- **fast-check** for property tests, focused on JSON-RPC parser and ACP
  message round-trips.
- **stryker** for mutation testing. Target ≥70% mutation score on
  changed code, computed against the non-ignored mutation set.
- **ACP test harness** under `lib/test-utils/`:
  - `in-memory-transport.mjs` — paired transports for client/backend
  - `fake-acp-backend.mjs` — scriptable fake backend
  - `fixture-replayer.mjs` — JSONL fixture playback
- **Fake CLI binaries** under `tests/integration/fakes/` for subprocess
  lifecycle tests without spawning real backends.
- **pino** for structured logging. stderr-only. Redaction first-class.
  Child loggers carry session/job context.
- **Wire log** as JSONL of every JSON-RPC frame, gated by `ACP_WIRE_LOG`
  env var. Same format as test fixtures. Wire-log → fixture pipeline
  scripted.
- **OpenTelemetry** lazy-loaded. Activates only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Default endpoint
  `http://localhost:4318` for local Jaeger/Tempo. Trace context propagated
  via non-standard `_otel.traceparent` ACP extension field.

## Impact

- **Affected specs**: introduces `testing` and `observability`.
- **Affected code**: every `console.log`/`console.error` call replaced
  with logger calls. New `lib/logger.mjs`, `lib/wire-log.mjs`,
  `lib/tracing.mjs`, `lib/test-utils/`.
- **Build size**: pino + redaction adds ~150KB. OTel lazy-loaded so adds
  zero unless activated.
- **CI time**: vitest is faster than the old shell-based runner; mutation
  testing adds a separate nightly job, not gating PRs.

## Dependencies

- Depends on `modernize-toolchain` being archived (pnpm, vitest install,
  Biome rule against `console.log`).

## Risks and Mitigations

- **Mutation score gaming**: ignoring mutations to hit threshold defeats
  the metric. Mitigation: ignored mutations tracked separately as a debt
  metric in `docs/mutation-debt.md`; growing list flags review even if
  score stays high.
- **OTel install size**: lazy-loaded via dynamic `import()` so cold-start
  cost is zero unless tracing is opted into.
- **Wire log credential leakage**: wire log redacts known credential
  field paths by default; documented in spec; an opt-in flag exists for
  full content with a warning.
- **OTel propagation through subprocesses**: `_otel.traceparent` is a
  non-standard extension field on ACP messages. Backend CLIs ignore
  unknown fields, so no compatibility break, but spans terminate at the
  subprocess boundary unless the backend implements its own
  propagation.

## Estimated Effort

3 weeks one engineer. 2 weeks with effective LLM assistance.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
