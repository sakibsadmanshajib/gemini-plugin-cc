# Spec Delta: testing

## ADDED Requirements

### Requirement: Vitest is the test runner

The repo SHALL use vitest as its sole test runner. Tests SHALL be written
in vitest's `describe`/`it`/`expect` style. The runner SHALL be invoked
via `pnpm test`. End-to-end tests SHALL be in a separate config gated by
`RUN_E2E=1`.

#### Scenario: Running unit tests

- **GIVEN** a clean checkout with dependencies installed
- **WHEN** the contributor runs `pnpm test`
- **THEN** vitest discovers tests under `tests/unit/`, `tests/integration/`,
  and `tests/property/`
- **AND** runs them in parallel
- **AND** reports a summary

#### Scenario: E2E tests are gated

- **GIVEN** a contributor runs `pnpm test`
- **WHEN** `RUN_E2E` is not set
- **THEN** tests under `tests/e2e/` do not run
- **AND** the test summary excludes them

#### Scenario: E2E tests run when explicitly enabled

- **GIVEN** a contributor runs `RUN_E2E=1 pnpm vitest --config vitest.e2e.config.mjs`
- **WHEN** the runner executes
- **THEN** only `tests/e2e/` tests run
- **AND** test timeout is 120 seconds (longer than default)

### Requirement: Property tests cover protocol edges

The repo SHALL include property-based tests (using `fast-check`) for
JSON-RPC framing and ACP message round-trips. The property tests SHALL
exercise:
- partial-line buffering
- multiple frames in one chunk
- malformed JSON
- unicode characters in string fields
- large message payloads (≥10 KB)

#### Scenario: Property tests run as part of pnpm test

- **GIVEN** the test suite
- **WHEN** `pnpm test` runs
- **THEN** property tests under `tests/property/` execute
- **AND** each property test runs at least 100 random cases by default

#### Scenario: Property failure is reproducible

- **GIVEN** a property test fails on a generated input
- **WHEN** the test runner reports the failure
- **THEN** the failure output includes the seed
- **AND** the seed can be passed to reproduce: `fc.assert(prop, { seed: <n> })`

### Requirement: Mutation testing protects test quality

The repo SHALL include mutation testing via `stryker`. The mutation score
on `lib/` (excluding `lib/test-utils/`) SHALL be ≥70%, computed against
the **non-ignored** mutation set. Ignored mutations SHALL be tracked in
`docs/mutation-debt.md` with a justification per mutation.

#### Scenario: Mutation score gate

- **GIVEN** the nightly mutation testing job
- **WHEN** the job completes
- **THEN** the score on `lib/` is ≥70% (non-ignored)
- **AND** if below, the job posts a comment to a tracking issue

#### Scenario: Ignored mutations are documented

- **GIVEN** an entry in `docs/mutation-debt.md`
- **WHEN** the entry is reviewed
- **THEN** it includes the mutation operator, file location, and reason
  for ignoring (e.g., "schema validator: this mutation produces
  equivalent code")
- **AND** the entry has an owner and a target removal date

#### Scenario: Mutation debt growing triggers review

- **GIVEN** the count of ignored mutations exceeds 5
- **WHEN** the mutation testing job runs
- **THEN** the job posts a warning even if the score is above threshold
- **AND** flags the debt count as needing reduction

### Requirement: ACP test harness available to all tests

The repo SHALL provide test utilities under `lib/test-utils/` for testing
ACP code without spawning real subprocesses or making real network calls.
The utilities SHALL include:
- `createInMemoryTransportPair()` — paired transports, A's writes appear
  on B's reads
- `fakeAcpBackend(transport)` — scriptable backend that emits
  notifications and answers requests via configured handlers
- `replayFixture(transport, path)` — plays a JSONL fixture, asserting
  outbound matches and emitting inbound

#### Scenario: Integration test uses in-memory transport

- **GIVEN** a test of session lifecycle
- **WHEN** the test instantiates the in-memory transport pair
- **THEN** the test wires the ACP client to one transport and a fake
  backend to the other
- **AND** the test runs to completion in under 100 ms
- **AND** no subprocesses are spawned

#### Scenario: Fixture replay validates protocol behavior

- **GIVEN** a recorded JSONL fixture from a real backend session
- **WHEN** the test runs `replayFixture(transport, path)`
- **THEN** the test asserts each outbound message from the client
  matches the fixture's expected outbound (with documented fuzzy fields
  like timestamps)
- **AND** the test plays back inbound messages from the fixture in order
- **AND** the test fails fast on the first mismatch with a diff

### Requirement: Subprocess lifecycle tests use fake binaries

The repo SHALL include fake CLI binaries under `tests/integration/fakes/`
for testing subprocess lifecycle without spawning real backends. The
fakes SHALL be invoked by tests that prepend the fakes directory to
`PATH`. The fakes SHALL accept JSON-RPC on stdin and emit configured
responses on stdout.

#### Scenario: Subprocess test spawns a fake

- **GIVEN** a test of subprocess crash recovery
- **WHEN** the test sets `PATH` to include `tests/integration/fakes/`
  first and spawns `gemini`
- **THEN** the spawned process is `fake-gemini.mjs`
- **AND** the test scripts the fake to exit non-zero after 100 ms
- **AND** the test verifies the adapter handles the crash correctly

## ADDED Requirements (Test Organization)

### Requirement: Test directory layout is consistent

Tests SHALL be organized as:
- `tests/unit/` — pure-function tests, no I/O
- `tests/integration/` — uses in-memory transport, fakes, or fixtures;
  no real subprocesses or network
- `tests/property/` — `fast-check`-driven tests
- `tests/e2e/` — real backends, real network; gated by `RUN_E2E=1`

#### Scenario: Wrong-tier test placement is caught in review

- **GIVEN** a test that spawns a real subprocess placed under
  `tests/integration/`
- **WHEN** code review runs
- **THEN** the reviewer flags the misplacement
- **AND** the test is moved to `tests/e2e/` or rewritten to use a fake

### Requirement: Fixtures pass redaction check before commit

Test fixtures under `tests/integration/fixtures/` SHALL contain no
unredacted secret patterns. A pre-commit (or CI) gate SHALL run the
redaction pipeline against each fixture; if any default redaction
pattern matches in the fixture content, the gate SHALL fail.

#### Scenario: Fixture with embedded API key blocks commit

- **GIVEN** a contributor stages a fixture file containing
  `sk-abcdef0123456789` in a captured prompt
- **WHEN** the pre-commit gate runs
- **THEN** the gate fails with the matched pattern's location
- **AND** the contributor is prompted to scrub the value before
  committing

#### Scenario: Clean fixture passes

- **GIVEN** a fixture with all secrets already replaced with
  `[REDACTED]` placeholders
- **WHEN** the gate runs
- **THEN** the gate passes
