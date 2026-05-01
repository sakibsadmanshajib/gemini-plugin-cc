# Spec Delta: transport-cli

## ADDED Requirements

### Requirement: CliTransport spawns a subprocess and speaks ACP

`CliTransport` SHALL spawn a subprocess using configured command and
arguments, and SHALL communicate with it via newline-framed JSON-RPC
over stdin/stdout. Stderr SHALL be captured and routed to the plugin's
logger (not to the user's terminal).

#### Scenario: Subprocess spawns on start

- **GIVEN** a `CliTransport` configured for `gemini --acp`
- **WHEN** `start()` is called
- **THEN** a child process is spawned with command `gemini` and args
  `['--acp']`
- **AND** stdin/stdout are piped, stderr is piped
- **AND** `start()` returns a promise that resolves with `{ sessionId }`
  after the ACP `initialize` and `session/new` handshake completes

#### Scenario: stderr routes to logger

- **GIVEN** the subprocess writes a line to stderr
- **WHEN** the line is received
- **THEN** the line is logged at `warn` level via the plugin's logger
- **AND** the line does not appear on the user's terminal directly

### Requirement: CliTransport handles graceful shutdown

`CliTransport` SHALL implement graceful shutdown: send SIGTERM, wait up
to 5 seconds for the process to exit, then send SIGKILL if still alive.

#### Scenario: Clean shutdown via SIGTERM

- **GIVEN** a running `CliTransport` with a responsive subprocess
- **WHEN** `close()` is called
- **THEN** the transport sends SIGTERM to the subprocess
- **AND** the subprocess exits within 5 seconds
- **AND** `close()` resolves

#### Scenario: Forceful shutdown via SIGKILL fallback

- **GIVEN** a running `CliTransport` with an unresponsive subprocess
- **WHEN** `close()` is called
- **AND** the subprocess does not exit within 5 seconds of SIGTERM
- **THEN** the transport sends SIGKILL
- **AND** the subprocess is terminated
- **AND** `close()` resolves with a `forced: true` indication
- **AND** a `warn` log line records the forced termination

#### Scenario: Close is idempotent

- **GIVEN** a `CliTransport` whose `close()` has been called and resolved
- **WHEN** `close()` is called a second time
- **THEN** the second call resolves without error
- **AND** no additional signals are sent

### Requirement: CliTransport detects unexpected crashes

`CliTransport` SHALL detect subprocess exits that occur without `close()` being called, emit a health transition to `worker_missing`, and reject any in-flight requests with an error referencing the exit code.

#### Scenario: Subprocess crashes mid-prompt

- **GIVEN** an in-flight `prompt()` call
- **WHEN** the subprocess exits with code 1
- **THEN** the in-flight prompt rejects with an error of kind
  `worker-missing` including `exitCode: 1`
- **AND** the transport's health transitions to `worker_missing`
- **AND** subsequent calls fail fast until `close()` then `start()` is
  re-invoked

### Requirement: CliTransport tracks heartbeat health

`CliTransport` SHALL track time since last activity from the subprocess
(any inbound message). The transport SHALL transition health labels:

- `active` — recent message within 10 seconds
- `quiet` — no message for 10-30 seconds
- `possibly_stalled` — no message for >30 seconds

The thresholds SHALL be configurable per backend.

#### Scenario: Active to quiet transition

- **GIVEN** a `CliTransport` with default thresholds, status `active`
- **WHEN** 11 seconds pass without any inbound message
- **THEN** the transport's health is `quiet`
- **AND** no log warning is emitted (`quiet` is not yet degraded)

#### Scenario: Quiet to possibly_stalled with warning

- **GIVEN** a transport with status `quiet`
- **WHEN** 31 seconds total elapse since last activity
- **THEN** the transport's health is `possibly_stalled`
- **AND** a `warn` log line is emitted referencing the transition

### Requirement: CliTransport conforms to AcpSession

`CliTransport` SHALL pass the `AcpSession` conformance test suite when
applied with a minimal ACP-speaking subprocess (real or fake).

#### Scenario: Conformance with fake binary

- **GIVEN** the conformance suite applied to a `CliTransport` configured
  to spawn `tests/integration/fakes/fake-gemini.mjs`
- **WHEN** the suite runs
- **THEN** all conformance tests pass

## ADDED Requirements (Configuration)

### Requirement: CliTransport accepts environment overrides

`CliTransport` SHALL accept an `env` parameter merged with the parent
process's environment when spawning the subprocess. The merge SHALL
prefer explicit `env` values over inherited values for the same keys.

#### Scenario: API key passed via env

- **GIVEN** a `CliTransport` configured with
  `env: { GEMINI_API_KEY: 'test-key' }`
- **WHEN** the subprocess spawns
- **THEN** the subprocess sees `GEMINI_API_KEY=test-key` regardless of
  what the parent process had

#### Scenario: Inherited environment by default

- **GIVEN** a `CliTransport` with no `env` parameter
- **WHEN** the subprocess spawns
- **THEN** the subprocess inherits the parent's full environment

### Requirement: CliTransport filters inherited environment

`CliTransport` SHALL NOT inherit the parent process's full environment
by default. The transport SHALL pass to the subprocess only:
- a documented allowlist of safe env vars (PATH, HOME, USER, LANG,
  LC_*, TMPDIR, NODE_PATH, TERM, SHELL)
- the explicit `env` parameter merged on top
- backend-specific env vars added by the backend declaration (e.g.,
  Gemini backend may add `GEMINI_API_KEY` if present in parent env)

#### Scenario: Unrelated credentials are not leaked

- **GIVEN** the parent plugin process has `OPENAI_API_KEY` and
  `GEMINI_API_KEY` set
- **WHEN** `CliTransport` spawns `gemini --acp` via the Gemini backend
- **THEN** the subprocess sees `GEMINI_API_KEY` (added by Gemini
  backend's env contributor)
- **AND** the subprocess does NOT see `OPENAI_API_KEY`
- **AND** `/proc/<child-pid>/environ` does not contain `OPENAI_API_KEY`

#### Scenario: PATH inheritance

- **GIVEN** a parent process with custom PATH including `~/.local/bin`
- **WHEN** the subprocess spawns
- **THEN** the subprocess inherits PATH unchanged
- **AND** can locate the same binaries as the parent

#### Scenario: Override via explicit env

- **GIVEN** `CliTransport` configured with `env: { GEMINI_API_KEY: 'override-key' }`
- **WHEN** the subprocess spawns
- **THEN** the explicit override wins over the backend's contributor
- **AND** the explicit value is used by the subprocess

### Requirement: Cancel-then-close uses tighter timing budget

When `cancel()` is called and is followed by `close()` (typical user
flow on Ctrl-C), the close path SHALL use a shorter shutdown budget
than a clean idle close. The combined cancel+close path SHALL complete
within 3 seconds: 1 second for ACP cancel acknowledgment, then SIGTERM,
then 2 seconds, then SIGKILL.

#### Scenario: User Ctrl-C during prompt

- **GIVEN** an active prompt
- **WHEN** `cancel()` is called, then immediately `close()`
- **THEN** the transport sends ACP cancel
- **AND** if the subprocess exits within 1 second, the close completes
- **AND** if not, SIGTERM is sent
- **AND** if the subprocess does not exit within 2 seconds of SIGTERM,
  SIGKILL is sent
- **AND** total time from `cancel()` invocation to close resolution is
  ≤ 3 seconds

#### Scenario: Idle close uses 5-second budget

- **GIVEN** a transport with no active prompt
- **WHEN** `close()` is called without prior `cancel()`
- **THEN** SIGTERM is sent immediately
- **AND** SIGKILL fallback applies after 5 seconds (per the original
  graceful-shutdown requirement)

### Requirement: Subprocess stderr is redacted before logging

`CliTransport` SHALL pass each line of subprocess stderr through the
shared value-pattern redactor (`lib/redaction-rules.mjs`) before
emitting a log line. Subprocess stderr is treated as untrusted input
that may contain secret values inadvertently echoed by the backend.

#### Scenario: Backend stderr containing API key is redacted

- **GIVEN** a misbehaving backend subprocess that emits the line
  `Error: invalid auth: Bearer sk-abc123def456...` to stderr
- **WHEN** `CliTransport` reads the line
- **THEN** the logged line contains `[REDACTED:apikey]` in place of
  the literal value
- **AND** no secret is preserved in the log

#### Scenario: Non-secret stderr passes through

- **GIVEN** a stderr line `[gemini] starting model gemini-3.1-pro-preview`
- **WHEN** `CliTransport` logs it
- **THEN** the line passes through unchanged
