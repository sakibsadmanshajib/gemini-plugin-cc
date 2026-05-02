# Spec Delta: acp-core

## ADDED Requirements

### Requirement: ACP messages use JSON-RPC 2.0 line framing

The plugin's ACP transport SHALL use JSON-RPC 2.0 messages framed as
newline-delimited JSON (one message per line). The framing SHALL handle
partial-line buffering across reads, multiple messages in a single read
chunk, and unicode characters in string fields.

#### Scenario: Single message per line

- **GIVEN** a stream emits `{"jsonrpc":"2.0","id":1,"method":"x"}\n`
- **WHEN** the framing parser reads the chunk
- **THEN** one message is yielded with the parsed object

#### Scenario: Multiple messages in one chunk

- **GIVEN** a stream emits two complete messages in one chunk:
  `{"jsonrpc":"2.0","id":1,"method":"x"}\n{"jsonrpc":"2.0","id":2,"method":"y"}\n`
- **WHEN** the framing parser reads the chunk
- **THEN** two messages are yielded in order

#### Scenario: Partial line buffered

- **GIVEN** a stream emits `{"jsonrpc":"2.0","id":1,"method":"x"` then
  `,"params":{}}\n` in two chunks
- **WHEN** the framing parser processes both chunks
- **THEN** one complete message is yielded after the second chunk
- **AND** no message is yielded after the first chunk

#### Scenario: Malformed line surfaces error

- **GIVEN** a stream emits `not-json\n`
- **WHEN** the framing parser reads the chunk
- **THEN** the parser raises a structured error
  (`{ kind: 'parse-error', line: 'not-json' }`)
- **AND** subsequent valid lines continue to parse

#### Scenario: Unicode in string fields

- **GIVEN** a message contains an emoji or non-ASCII character in a
  string field
- **WHEN** the framing parser reads the chunk
- **THEN** the parsed object preserves the character
- **AND** no double-decoding occurs

### Requirement: AcpSession is the contract for backend access

The plugin SHALL define an `AcpSession` interface (as JSDoc types) that
represents an active session with a backend. All transports and backends
SHALL conform. The interface SHALL include:

- `start(): Promise<{ sessionId: string }>`
- `prompt(text, opts?): Promise<void>`
- `cancel(): Promise<void>`
- `close(): Promise<void>`
- `onUpdate(handler): Unsubscribe`
- `onPermission(handler): Unsubscribe`
- `health(): HealthState`

#### Scenario: Conforming implementation passes the suite

- **GIVEN** a new `AcpSession` implementation
- **WHEN** the conformance test suite is applied via
  `runConformanceSuite('my-impl', factory)`
- **THEN** the suite runs all conformance tests
- **AND** all tests pass

#### Scenario: Non-conforming implementation fails fast

- **GIVEN** an implementation missing the `cancel` method
- **WHEN** the conformance test suite runs
- **THEN** the suite reports a missing-method error before running
  behavioral tests

### Requirement: ACP client is transport-agnostic

The plugin SHALL provide a generic ACP client that works against any
object implementing the transport contract (low-level write, line
emission, close). The client SHALL handle:

- request/response correlation via `id` field
- timeout per request (configurable; default 30 seconds)
- notification dispatch to registered handlers

#### Scenario: Request/response correlation

- **GIVEN** the client sends two concurrent requests with `id: 1` and
  `id: 2`
- **WHEN** the backend responds with `id: 2` first, then `id: 1`
- **THEN** the client resolves the second promise first
- **AND** then the first promise

#### Scenario: Request timeout

- **GIVEN** the client sends a request with a 1-second timeout
- **WHEN** no response arrives within 1 second
- **THEN** the client rejects the request with a timeout error
- **AND** ignores any later response with the same `id`

### Requirement: Conformance test suite covers session lifecycle

The plugin SHALL provide a conformance test suite (exposed via
`runConformanceSuite(name, factory)`) that any `AcpSession`
implementation can be tested against. The suite SHALL cover at minimum:

- session/new returns a non-empty `sessionId`
- prompt sends produce at least one `session/update` notification
- prompt sends complete (the prompt promise resolves) when the
  backend signals completion
- cancel mid-prompt halts further notifications within 500 ms
- close releases all resources (subprocess, sockets, listeners)
- close is idempotent (second call is a no-op)
- permission requests round-trip: backend asks → client decides →
  decision reaches backend → backend acts on the decision
- health transitions are observable via `health()` method

#### Scenario: Conformance suite enumerates required cases

- **GIVEN** the conformance module
- **WHEN** the contributor reads `lib/test-utils/conformance.mjs`
- **THEN** each of the listed behaviors has a named test
- **AND** the suite is run against `MockBackend`, `CliTransport` (with
  fake binary), and `geminiBackend.transports.cli(...)`
- **AND** all three pass

#### Scenario: New backend implementor can run the suite

- **GIVEN** a new backend implementation written by a contributor
- **WHEN** the contributor calls `runConformanceSuite('my-backend', factory)`
- **THEN** the suite reports per-test pass/fail
- **AND** failures produce diff output usable to fix the implementation
