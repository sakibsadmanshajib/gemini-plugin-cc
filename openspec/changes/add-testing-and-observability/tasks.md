# Tasks: add-testing-and-observability

## 1. Vitest baseline

- [ ] T1.1 — Install `vitest` and `@vitest/coverage-v8` as devDependencies
- [ ] T1.2 — Create `vitest.config.mjs` with `include: ['tests/unit/**/*.test.mjs', 'tests/integration/**/*.test.mjs', 'tests/property/**/*.test.mjs']`
- [ ] T1.3 — Add `pnpm test` and `pnpm test:cov` scripts
- [ ] T1.4 — Migrate any existing tests in `tests/` from shell to vitest
- [ ] T1.5 — Delete `test.sh`; update README and CONTRIBUTING.md
- [ ] T1.6 — Add `vitest.e2e.config.mjs` for E2E tests gated by `RUN_E2E=1`

## 2. Property tests

- [ ] T2.1 — Install `fast-check` as devDependency
- [ ] T2.2 — Create `tests/property/jsonrpc-framing.test.mjs` covering line
  splitting, partial buffers, malformed frames, unicode in strings
- [ ] T2.3 — Create `tests/property/message-roundtrip.test.mjs` covering
  ACP message serialize → deserialize round-trip preservation

## 3. Mutation testing

- [ ] T3.1 — Install `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`
  as devDependencies
- [ ] T3.2 — Create `stryker.config.mjs` targeting `lib/**/*.mjs`,
  excluding `lib/test-utils/`
- [ ] T3.3 — Add `pnpm test:mutation` script
- [ ] T3.4 — Add nightly CI job `mutation-testing.yml` running on a cron
- [ ] T3.5 — Document ≥70% mutation score policy in `docs/testing.md`
- [ ] T3.6 — Create `docs/mutation-debt.md` listing any ignored mutations
  with rationale

## 4. ACP test harness

- [ ] T4.1 — `lib/test-utils/in-memory-transport.mjs`: paired transports
  with `EventEmitter`-based message flow, supports `write`, `onLine`,
  `close`
- [ ] T4.2 — `lib/test-utils/fake-acp-backend.mjs`: scriptable backend
  emitting `session/update` notifications on demand, responding to
  requests with configurable handlers
- [ ] T4.3 — `lib/test-utils/fixture-replayer.mjs`: reads JSONL fixture,
  asserts outbound messages match (with fuzzy fields like timestamps),
  plays back inbound messages between outbound assertions
- [ ] T4.4 — Unit tests for each test util
- [ ] T4.5 — Document fixture format in `docs/test-fixtures.md`
- [ ] T4.6 — Provide one canonical fixture per backend in
  `tests/integration/fixtures/` (gemini-rescue-success.jsonl,
  gemini-cancel-mid-stream.jsonl)

## 5. Fake CLI binaries

- [ ] T5.1 — `tests/integration/fakes/fake-gemini.mjs`: reads JSON-RPC
  from stdin, emits scripted responses; controllable via env var
  `FAKE_GEMINI_SCRIPT=path/to/script.json`
- [ ] T5.2 — Test harness `lib/test-utils/with-fake-binary.mjs`: sets PATH
  to put fakes first, restores on cleanup
- [ ] T5.3 — Subprocess lifecycle test using fake-gemini: spawn, send
  prompt, send cancel, verify clean exit with SIGTERM, fallback to
  SIGKILL after 5s

## 6. Pino logging

- [ ] T6.1 — Install `pino` and `pino-pretty` (devDep) as deps
- [ ] T6.2 — Create `lib/logger.mjs`:
  - log level from `ACP_LOG_LEVEL` (default `info`)
  - destination is stderr (never stdout)
  - redact paths for known credential fields
  - pretty-print on TTY, JSON otherwise
  - `mixin()` adds traceId/spanId from active OTel span if present
- [ ] T6.3 — Replace every `console.log` and `console.error` with
  `logger.info/warn/error` calls; verify Biome lint catches future
  regressions
- [ ] T6.4 — Add child logger pattern in session and job code paths
- [ ] T6.5 — Document log levels and redaction in `docs/observability.md`

## 7. Wire log

- [ ] T7.1 — Create `lib/wire-log.mjs` with `createWireLogger(path)`
  factory returning `{ in, out, close }` methods
- [ ] T7.2 — Wire log writes JSONL: `{ t: timestamp, direction: 'in'|'out', msg: ... }`
- [ ] T7.3 — Default redaction: known credential field paths replaced
  with `[REDACTED]`; large blobs (>1KB in `content` fields) truncated
- [ ] T7.4 — Hook wire logger into ACP transport read/write via dependency
  injection; gated by `ACP_WIRE_LOG` env var (off by default)
- [ ] T7.5 — Create `scripts/wire-log-to-fixture.mjs` to convert wire log
  → fixture (strips PII more aggressively, normalizes timestamps,
  validates JSON shapes)
- [ ] T7.6 — Document wire log format and "bug → fixture" workflow in
  `docs/observability.md`

## 8. OpenTelemetry (lazy-loaded)

- [ ] T8.1 — Add OTel SDK packages as **optional** dependencies
  (`peerDependenciesMeta` with `optional: true`):
  `@opentelemetry/api`, `@opentelemetry/sdk-node`,
  `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/auto-instrumentations-node`
- [ ] T8.2 — Create `lib/tracing.mjs`:
  - `startTracing()` returns immediately if no
    `OTEL_EXPORTER_OTLP_ENDPOINT`
  - dynamically imports OTel SDK only when activated
  - default endpoint `http://localhost:4318`
- [ ] T8.3 — Instrument `session/new`, `session/cancel`, `session/prompt`,
  `acp.tool_call`, `backend.spawn`, `git.diff_collect` spans
- [ ] T8.4 — Inject `_otel.traceparent` into outbound ACP messages when
  tracing is active; extract on inbound; document as non-standard
  extension
- [ ] T8.5 — Pino mixin reads active span; adds `traceId`, `spanId` to log
  records when tracing is active
- [ ] T8.6 — Document local Jaeger setup in `docs/observability.md`
  (docker-compose snippet for `jaegertracing/all-in-one`)

## 9. Health label integration

- [ ] T9.1 — Existing health label state machine (active/quiet/
  possibly_stalled/rate_limited/auth_required/etc.) emits log lines
  at `warn` on degraded transitions, `info` on recovery
- [ ] T9.2 — Health transitions become OTel span events
  (`span.addEvent('health.transition', { from, to })`)
- [ ] T9.3 — Test: simulate broker timeout, verify health transition
  emits expected log line and span event

## 10. Verification

- [ ] T10.1 — vitest passes 100% on the feature branch
- [ ] T10.2 — Mutation score ≥70% on `lib/`, excluding ignored mutations
  (ignored list ≤ 5)
- [ ] T10.3 — Wire log → fixture → regression test cycle proven on at
  least one real or synthetic bug; documented in
  `docs/observability.md` as worked example
- [ ] T10.4 — OTel local-only test: run with
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, verify spans
  appear in local Jaeger UI
- [ ] T10.5 — Cold-start test: time `node companion.mjs --version` with
  and without OTel env var; document overhead in `docs/performance.md`
- [ ] T10.6 — At least 2 PRs reviewed via `/codex:adversarial-review`

## Acceptance

- [ ] All tasks complete
- [ ] CI green, including new mutation testing nightly job
- [ ] No regressions in existing functionality
- [ ] No `console.log`/`console.error` remain (lint enforces)
- [ ] Worked example of wire-log-to-fixture pipeline lives in repo
