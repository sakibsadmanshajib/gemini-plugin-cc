# Spec Delta: transport-http

## ADDED Requirements

### Requirement: HttpTransport spawns an App Server and communicates over HTTP+SSE

`HttpTransport` SHALL spawn a long-running App Server subprocess
(e.g., `codex --app-server`), wait for the server to be ready, and
communicate with it via HTTP for requests and Server-Sent Events for
streaming updates. The transport SHALL conform to `AcpSession`.

#### Scenario: Server spawn and ready detection

- **GIVEN** a `HttpTransport` configured for `codex --app-server`
- **WHEN** `start()` is called
- **THEN** a subprocess is spawned
- **AND** the transport polls the configured port for readiness
- **AND** within a configurable timeout (default 10 seconds), the
  server responds to a health probe
- **AND** `start()` resolves with `{ sessionId }` after creating a
  session via the App Server's session-creation endpoint

#### Scenario: Server fails to become ready

- **GIVEN** the spawned server fails to start within timeout
- **WHEN** `start()` is called
- **THEN** the transport kills the subprocess
- **AND** `start()` rejects with a structured error referencing the
  timeout

### Requirement: HttpTransport handles port allocation

`HttpTransport` SHALL accept a `port` parameter. When `port: 0`, the
transport SHALL request an OS-assigned port. When an explicit port is
provided, the transport SHALL fail fast if the port is unavailable.

#### Scenario: OS-assigned port

- **GIVEN** `HttpTransport` configured with `port: 0`
- **WHEN** `start()` is called
- **THEN** the transport spawns the server with `--port 0`
- **AND** parses the actual port from the server's startup output
- **AND** uses that port for subsequent requests

#### Scenario: Port conflict fails fast

- **GIVEN** `HttpTransport` configured with `port: 12345`
- **AND** another process is bound to port 12345
- **WHEN** `start()` is called
- **THEN** the transport detects the conflict
- **AND** `start()` rejects with `kind: 'port-conflict'`

### Requirement: HttpTransport uses undici for HTTP

The plugin SHALL use `undici` (Node's modern HTTP client) for HTTP
calls, not `node-fetch` or third-party libraries. `undici` provides
cleaner abort signal propagation and built-in connection pooling.

#### Scenario: Cancellation aborts in-flight HTTP request

- **GIVEN** an in-flight HTTP request from `HttpTransport`
- **WHEN** `cancel()` is called
- **THEN** the request's AbortController is signaled
- **AND** undici aborts the connection promptly
- **AND** the request promise rejects with `kind: 'aborted'`

### Requirement: HttpTransport parses SSE events

The transport SHALL maintain an SSE connection to the App Server's
event stream. SSE events SHALL be parsed and translated to ACP
`session/update` shapes via the configured translator.

#### Scenario: SSE event arrives and translates

- **GIVEN** an active SSE connection
- **WHEN** the server emits an event
- **THEN** the transport parses the event
- **AND** invokes the translator
- **AND** dispatches non-null translations to `onUpdate` handlers

#### Scenario: SSE disconnect triggers health degradation

- **GIVEN** an active SSE connection
- **WHEN** the connection drops unexpectedly
- **THEN** the transport's health transitions to `broker_unhealthy`
- **AND** a `warn` log is emitted
- **AND** the transport attempts reconnection (up to a configurable
  retry budget)

### Requirement: HttpTransport supports server crash recovery

If the App Server subprocess exits unexpectedly, the transport SHALL
emit a `worker_missing` health transition and reject in-flight
requests with a structured error.

#### Scenario: App Server crashes mid-session

- **GIVEN** an active session
- **WHEN** the App Server subprocess exits with code 1
- **THEN** the transport's health transitions to `worker_missing`
- **AND** in-flight requests reject with `kind: 'worker-missing'`,
  `exitCode: 1`
- **AND** subsequent operations fail until `close()` then `start()`
  is re-invoked

### Requirement: HttpTransport binds to loopback by default

The spawned App Server subprocess SHALL be invoked with an explicit
loopback bind argument (e.g., `--bind 127.0.0.1`). The transport
SHALL refuse to connect to a non-loopback host unless
`ACP_HTTP_ALLOW_REMOTE=1` is set in the environment. The default
disposition prevents the local agent server from being reachable
from the network.

#### Scenario: Default bind is loopback

- **GIVEN** `HttpTransport` is started without `ACP_HTTP_ALLOW_REMOTE`
- **WHEN** the subprocess is spawned
- **THEN** the subprocess's argv includes a loopback bind argument
- **AND** the transport's HTTP base URL is `http://127.0.0.1:<port>`

#### Scenario: Non-loopback target rejected without override

- **GIVEN** a configuration that points the transport at
  `http://10.0.0.5:8080` (a non-loopback host)
- **AND** `ACP_HTTP_ALLOW_REMOTE` is not set
- **WHEN** `start()` is called
- **THEN** `start()` rejects with `kind: 'remote-disallowed'`
- **AND** an error log explains the override env var

#### Scenario: Explicit override permits remote

- **GIVEN** `ACP_HTTP_ALLOW_REMOTE=1` is set
- **AND** a non-loopback target host is configured
- **WHEN** `start()` is called
- **THEN** the transport connects normally
- **AND** a `warn` log records that remote App Server use is enabled

### Requirement: HttpTransport conforms to AcpSession

`HttpTransport` SHALL pass the conformance test suite when applied
with a fake App Server.

#### Scenario: Conformance with fake App Server

- **GIVEN** the conformance suite applied to a `HttpTransport`
  configured with a fake server (e.g., a vitest-controlled HTTP
  server in `tests/integration/fakes/`)
- **WHEN** the suite runs
- **THEN** all conformance tests pass

### Requirement: SSE disconnect fails in-flight prompts

When the SSE event stream drops unexpectedly, in-flight prompts SHALL
fail with a structured error. Reconnection attempts apply only to
*future* prompts, not to recovering the dropped prompt's stream.

#### Scenario: SSE drop fails active prompt

- **GIVEN** an active prompt streaming via SSE
- **WHEN** the SSE connection drops
- **THEN** the prompt promise rejects with `kind: 'broker-unhealthy'`
- **AND** the rejection error includes `reason: 'sse-disconnect'`
- **AND** the transport's health transitions to `broker_unhealthy`

#### Scenario: Reconnection allows new prompts

- **GIVEN** a transport in `broker_unhealthy` state from SSE drop
- **WHEN** the transport completes a successful reconnection (within
  the 3-attempt budget with 1s/2s/4s backoff)
- **THEN** the transport's health returns to `active`
- **AND** the user can submit a new prompt
- **AND** the new prompt's events stream over the new SSE connection

#### Scenario: Reconnection budget exhausted

- **GIVEN** a transport that fails 3 reconnect attempts
- **WHEN** the third reconnect fails
- **THEN** the transport's health remains `broker_unhealthy`
- **AND** new prompts fail fast with `kind: 'broker-unhealthy'`
- **AND** the user must `close()` and `start()` to recover (or
  re-invoke the slash command)

### Requirement: App Server binds to loopback only

`HttpTransport` SHALL bind the spawned App Server subprocess to loopback only. The spawn command SHALL include explicit loopback binding (e.g., `--bind 127.0.0.1` or `--host localhost`), and the transport SHALL NOT spawn an App Server reachable from non-local interfaces.

#### Scenario: Spawned server is loopback-only

- **GIVEN** `HttpTransport` configured for Codex App Server
- **WHEN** `start()` spawns the subprocess
- **THEN** the spawn args include `--bind 127.0.0.1` (or the App
  Server's equivalent loopback flag)
- **AND** an external machine attempting to connect to the host's
  IP on the chosen port is refused

#### Scenario: Bind override blocked

- **GIVEN** a user configures `HttpTransport` with custom args that
  attempt to override binding to `0.0.0.0`
- **WHEN** the transport spawns the subprocess
- **THEN** the transport detects the unsafe override
- **AND** rejects the configuration with a structured error
- **AND** logs the rejection
