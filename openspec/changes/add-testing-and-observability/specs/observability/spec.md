# Spec Delta: observability

## ADDED Requirements

### Requirement: Diagnostic logging via pino on stderr

The plugin SHALL use pino for structured logging. All log output SHALL be
written to stderr. The plugin SHALL NOT write log output to stdout under
any circumstances; stdout is reserved for the JSON-RPC channel.

#### Scenario: Log output goes to stderr

- **GIVEN** the plugin is running
- **WHEN** any log line is emitted at any level
- **THEN** the line appears on stderr
- **AND** stdout contains only JSON-RPC protocol messages

#### Scenario: Log level configurable via env

- **GIVEN** `ACP_LOG_LEVEL=debug` is set
- **WHEN** the plugin starts
- **THEN** debug-level log lines are emitted
- **AND** trace-level lines are still suppressed (require explicit `trace`)

#### Scenario: Default log level is info

- **GIVEN** no `ACP_LOG_LEVEL` is set
- **WHEN** the plugin starts
- **THEN** info, warn, error, and fatal lines are emitted
- **AND** debug and trace lines are suppressed

#### Scenario: Pretty-printing on TTY, JSON otherwise

- **GIVEN** the plugin's stderr is connected to a TTY
- **WHEN** a log line is emitted
- **THEN** the line is human-readable with colorization
- **GIVEN** the plugin's stderr is piped to a file or non-TTY
- **WHEN** a log line is emitted
- **THEN** the line is JSON one-per-line

### Requirement: Sensitive fields are redacted by default

The logger SHALL redact known sensitive paths from log records before
emission. The redaction list SHALL include at minimum:

- `*.headers.authorization`
- `*.headers.cookie`
- `*.params.apiKey`, `*.params.api_key`
- `*.env.GEMINI_API_KEY`, `*.env.ANTHROPIC_API_KEY`,
  `*.env.OPENAI_API_KEY`, `*.env.GOOGLE_API_KEY`
- `*.credentials.*`

The redaction censor SHALL be `[REDACTED]`.

#### Scenario: API key in log payload is redacted

- **GIVEN** a log call passing `{ env: { GEMINI_API_KEY: 'real-key' } }`
- **WHEN** the line is emitted
- **THEN** the emitted line shows `env.GEMINI_API_KEY: '[REDACTED]'`
- **AND** the literal key value does not appear

### Requirement: Wire log captures every JSON-RPC frame

The plugin SHALL provide an opt-in wire log mechanism. When activated via
`ACP_WIRE_LOG=<path>`, the plugin SHALL append one JSONL line per
JSON-RPC frame (in either direction) to that path. Each line SHALL have
the shape:

```json
{ "t": <unix-millis>, "direction": "in" | "out", "msg": <frame> }
```

#### Scenario: Wire log off by default

- **GIVEN** `ACP_WIRE_LOG` is not set
- **WHEN** the plugin handles JSON-RPC traffic
- **THEN** no wire log file is created
- **AND** no per-frame I/O overhead is incurred beyond logging

#### Scenario: Wire log captures both directions

- **GIVEN** `ACP_WIRE_LOG=/tmp/wire.jsonl` is set
- **WHEN** the plugin handles a session that sends 3 outbound and
  receives 5 inbound frames
- **THEN** `/tmp/wire.jsonl` contains 8 lines
- **AND** each line has a valid timestamp, direction, and `msg` payload

#### Scenario: Wire log redacts known credential paths

- **GIVEN** `ACP_WIRE_LOG=/tmp/wire.jsonl` is set
- **AND** an outbound message includes a credential field path
- **WHEN** the line is written
- **THEN** the credential value is replaced with `[REDACTED]`

#### Scenario: Wire log truncates large content fields

- **GIVEN** `ACP_WIRE_LOG=/tmp/wire.jsonl` is set
- **AND** an inbound message contains a `content` field of 1 MB
- **WHEN** the line is written
- **THEN** the line is < 5 KB
- **AND** the `content` field shows
  `{ "truncated": true, "originalLength": 1048576, "preview": "<first 1 KB>" }`

#### Scenario: Wire log to fixture pipeline

- **GIVEN** a wire log file `wire.jsonl`
- **WHEN** the contributor runs
  `node scripts/wire-log-to-fixture.mjs wire.jsonl > fixture.jsonl`
- **THEN** `fixture.jsonl` is a normalized version (timestamps zeroed,
  PII fields stripped beyond default redaction, JSON re-formatted)
- **AND** the resulting fixture passes `replayFixture()`

### Requirement: OpenTelemetry tracing is lazy-loaded

The plugin SHALL provide OpenTelemetry tracing as an opt-in feature. The
OTel SDK SHALL be imported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
in the environment. When the env var is not set, no OTel code paths
SHALL execute and no OTel dependencies SHALL be loaded into memory.

#### Scenario: OTel disabled by default

- **GIVEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
- **WHEN** the plugin starts
- **THEN** the OTel SDK is not imported (verifiable via heap snapshot or
  `require.cache` inspection)
- **AND** no OTLP traffic is generated

#### Scenario: OTel activates with endpoint set

- **GIVEN** `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` is set
- **WHEN** the plugin starts
- **THEN** the OTel SDK is dynamically imported
- **AND** spans are emitted to the configured endpoint

#### Scenario: OTel local Jaeger workflow

- **GIVEN** a contributor runs Jaeger via the documented docker-compose
  snippet
- **AND** sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
- **WHEN** the contributor runs the plugin against a backend
- **THEN** spans appear in the local Jaeger UI within 10 seconds
- **AND** the trace shows `session/new`, tool calls, and exit

### Requirement: Trace context propagated through ACP messages

When tracing is active, the plugin SHALL inject the current trace context
into outbound ACP messages as a non-standard `_otel.traceparent` field
in `params`. The plugin SHALL extract `_otel.traceparent` from inbound
messages and continue the trace.

#### Scenario: Outbound message carries traceparent

- **GIVEN** tracing is active and a span is in scope
- **WHEN** the plugin sends `session/new`
- **THEN** the outbound message's `params._otel.traceparent` matches the
  W3C traceparent format
- **AND** equals the active span's traceparent header value

#### Scenario: Backend without OTel ignores _otel field

- **GIVEN** the plugin sends `_otel.traceparent` to a backend that does
  not understand the extension
- **WHEN** the backend processes the message
- **THEN** the backend handles the message normally (per JSON-RPC: ignore
  unknown fields)
- **AND** no error is returned

#### Scenario: Trace ID appears in log lines

- **GIVEN** tracing is active and pino is configured with the OTel mixin
- **WHEN** a log line is emitted within an active span
- **THEN** the log record includes `traceId` and `spanId` fields
- **AND** the trace ID matches the active span's context

### Requirement: Health label transitions are observable

The existing health label state machine SHALL emit observability signals
on transitions:
- a `warn`-level log line when entering a non-healthy state
  (`possibly_stalled`, `rate_limited`, `auth_required`, `worker_missing`,
  `broker_unhealthy`, `failed`)
- an `info`-level log line when recovering to `active`
- a span event (`health.transition`) on the active session span when
  tracing is active

#### Scenario: Rate-limit transition logs warn

- **GIVEN** a session is `active`
- **WHEN** the backend reports a rate limit
- **AND** the health label transitions to `rate_limited`
- **THEN** a `warn` log line is emitted with `{ from: 'active', to: 'rate_limited' }`

#### Scenario: Health event on active span

- **GIVEN** tracing is active for a session
- **WHEN** the health label transitions
- **THEN** the active session span gains an event named
  `health.transition`
- **AND** the event has attributes `from` and `to`

## ADDED Requirements (Performance and Cold Start)

### Requirement: Cold-start overhead is bounded

The plugin's cold-start time (time from process spawn to readiness for
first JSON-RPC frame) SHALL NOT exceed 200 ms when tracing is disabled,
on a baseline machine spec documented in `docs/performance.md`.

#### Scenario: Baseline cold-start measurement

- **GIVEN** the baseline machine spec
- **WHEN** the contributor runs the cold-start benchmark
- **THEN** the measured cold-start time is ≤ 200 ms
- **AND** the measurement is recorded in `docs/performance.md`

#### Scenario: OTel adds bounded overhead

- **GIVEN** the cold-start benchmark
- **WHEN** OTel is activated via env var
- **THEN** the cold-start time is ≤ 350 ms
- **AND** the additional ~150 ms is documented as the OTel cost
