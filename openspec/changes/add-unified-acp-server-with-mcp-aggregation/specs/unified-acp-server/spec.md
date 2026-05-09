# unified-acp-server

A long-lived server bin (`artagon-acp-server`) that exposes the
artagon suite as an ACP-speaking endpoint, multiplexing requests
across claude/codex/gemini backends. Brings backends into a single
warm, persistent surface; aggregates MCP tools across backends into
a unified catalog.

## ADDED Requirements

### Requirement: Server bin

The suite SHALL ship a new bin `artagon-acp-server` registered in
`package.json` `bin` map. The bin SHALL parse argv via commander and
expose flags equivalent to `bin/artagon-openai-server.mjs` plus
ACP-specific flags (`--listen`, `--backend`, `--mcp-aggregation`,
`--idle-ms`).

#### Scenario: Bin registered

- **GIVEN** the package is installed globally via npm or pnpm
- **WHEN** the operator runs `which artagon-acp-server`
- **THEN** the path resolves to a file in the global bin directory

#### Scenario: --help lists ACP-specific flags

- **GIVEN** the bin is on PATH
- **WHEN** the operator runs `artagon-acp-server --help`
- **THEN** the output includes `--listen`, `--backend`,
  `--mcp-aggregation`, `--idle-ms` AND the standard auth flags
  (`--api-key`, `--api-key-file`, `--auto-key`, `--auto-key-rotate`,
  `--auto-key-store`)

### Requirement: Listen transports

The server SHALL support three listen transports: `stdio` (default),
`unix://<path>`, and `ws://<host>:<port>`. The `--listen` flag MUST
parse all three forms.

#### Scenario: stdio listen (default)

- **GIVEN** the bin is invoked with no `--listen`
- **WHEN** the server completes initialization
- **THEN** it reads ACP JSON-RPC from stdin and writes to stdout

#### Scenario: unix socket listen

- **GIVEN** the bin is invoked with `--listen unix:///tmp/artagon.sock`
- **WHEN** the server completes initialization
- **THEN** a Unix socket file exists at the path with mode 0o600
- **AND** an ACP client can connect via that socket

#### Scenario: WebSocket listen

- **GIVEN** the bin is invoked with `--listen ws://127.0.0.1:8765`
- **WHEN** the server completes initialization
- **THEN** the server accepts WebSocket connections at the address
  AND speaks ACP framed per JSON-RPC over WebSocket

### Requirement: ACP method coverage

The server SHALL implement the ACP methods `initialize`,
`authenticate`, `session/new`, `session/load`, `session/prompt`,
`session/cancel`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`, `prompts/list`, `prompts/get`. Any method outside
this list MUST be answered with the standard JSON-RPC `method not
found` error.

#### Scenario: initialize round-trip

- **GIVEN** a connected ACP client
- **WHEN** the client sends `initialize` with valid clientCapabilities
- **THEN** the server replies with serverCapabilities listing
  `prompts`, `tools`, `resources` (when MCP aggregation is on)

#### Scenario: unknown method rejected

- **GIVEN** a connected ACP client
- **WHEN** the client sends a JSON-RPC request with method
  `nonexistent/method`
- **THEN** the server replies with error `code: -32601` (method not
  found)

### Requirement: Backend routing

The server SHALL route incoming `session/prompt` requests to one of
the three backend adapters (`claude`, `codex`, `gemini`). Routing
order MUST be:

1. The `model` field on the prompt (resolved through
   `lib/backends/*/aliases.mjs`)
2. The session's bound backend (sticky binding from the first turn)
3. The `--backend <name>` server flag
4. The `ARTAGON_ACP_BACKEND` env var
5. Hard-coded default `claude`

#### Scenario: model field selects backend

- **GIVEN** the server is running with no `--backend` flag
- **WHEN** a client sends `session/prompt` with
  `params.model = "gpt-5"`
- **THEN** the request routes to the codex backend adapter

#### Scenario: session sticky binding

- **GIVEN** a session has handled one turn via the gemini backend
- **WHEN** a subsequent `session/prompt` arrives in the same session
  with no `model` field
- **THEN** the request routes to the gemini backend (sticky binding
  from turn 1)

#### Scenario: env var fallback

- **GIVEN** the server is running with `ARTAGON_ACP_BACKEND=codex`
- **AND** no `--backend` flag is set
- **WHEN** a `session/prompt` arrives with no `model` field and no
  prior backend binding
- **THEN** the request routes to codex

### Requirement: Per-backend adapter contract

Each backend adapter (claude, codex, gemini) SHALL implement the
same external interface: `start()`, `prompt(opts) →
AsyncIterator<SessionUpdate>`, `cancel(sessionId)`, `close()`,
`health()`. Each adapter MUST manage a single long-lived child
process owned by the adapter; multiple turns are multiplexed
through that one child.

#### Scenario: One child per backend

- **GIVEN** the server is running with all three backends warm
- **WHEN** the operator inspects child processes via `ps`
- **THEN** at most one `gemini --acp` child exists per backend
  AND at most one `codex app-server` child exists
  AND at most one claude-code-acp child exists

#### Scenario: Child reuse across turns

- **GIVEN** a backend adapter has handled one turn (child PID = N)
- **WHEN** the next turn arrives within the idle timeout window
- **THEN** the same child (PID = N) handles it; no new spawn

### Requirement: Idle-timeout reaping

Each backend adapter SHALL exit its child after a configurable idle
period. Default: 5 minutes. Configurable via `--idle-ms <ms>` CLI
flag or `ARTAGON_ACP_IDLE_MS` env var.

#### Scenario: Default idle timeout

- **GIVEN** a backend adapter is healthy with no in-flight turns
- **WHEN** 5 minutes elapse with no new turns
- **THEN** the adapter sends SIGTERM to the child
  AND the child exits within 10s
  AND the adapter's health label transitions to `dead`

### Requirement: Crash recovery

Each backend adapter SHALL detect child crashes (exit code != 0 OR
SIGSEGV/SIGKILL) and restart the child up to 5 times with
exponential backoff (250ms, 500ms, 1s, 2s, 4s). After 5 failed
restarts, the adapter SHALL mark health as `dead` and reject new
turns until the operator restarts the server.

#### Scenario: First crash auto-recovers

- **GIVEN** a backend adapter is healthy
- **WHEN** the child crashes with SIGSEGV mid-turn
- **THEN** the in-flight turn rejects with a crash error
  AND the adapter health transitions through `degraded` → `restarting`
  AND the next turn (after restart) succeeds against a new child

#### Scenario: Five crashes mark dead

- **GIVEN** a backend's child crashes immediately on every spawn
- **WHEN** the adapter has restarted 5 times
- **THEN** the adapter health is `dead`
  AND subsequent `prompt()` calls reject with "backend unavailable"

### Requirement: Codex protocol translation

The codex backend adapter SHALL translate between our ACP shape and
Codex's `app-server` JSON-RPC dialect via
`lib/translate/codex-app-server.mjs`. Translation MUST be schema-
validated against the vendored Codex schema at
`lib/backends/codex/app-server-schema/`.

#### Scenario: prompt → newConversation + sendUserMessage

- **GIVEN** the codex adapter has a healthy `codex app-server` child
- **WHEN** an ACP `session/prompt` arrives
- **THEN** the adapter sends a Codex `newConversation` request
  AND then a Codex `sendUserMessage` request
- **AND** Codex `streamChunk` notifications translate to ACP
  `session/update` notifications with `agent_message_chunk` content

#### Scenario: Schema drift fails CI

- **GIVEN** a developer bumps the codex CLI version
- **WHEN** they run `pnpm test:codex-schema-canary`
- **THEN** if the live `codex app-server generate-json-schema` output
  differs from the vendored schema, the test fails with a diff
  pointing at the offending types

### Requirement: Claude adapter delegation

The claude backend adapter SHALL delegate to
`@zed-industries/claude-code-acp` (or its successor named in
package.json). The adapter SHALL NOT reimplement claude-as-ACP from
scratch.

#### Scenario: Adapter spawns claude-code-acp

- **GIVEN** the server is starting the claude adapter
- **WHEN** the adapter `start()`s
- **THEN** it spawns the `@zed-industries/claude-code-acp` bin via
  stdio AND speaks ACP through it

### Requirement: Endpoint manifest

On listen, the server SHALL write
`$XDG_STATE_HOME/artagon-agent-cli-plugin/acp-server.json` with mode
0o600 containing the connection details (transport, address, pid,
startedAt, autoKey retrieve command if applicable, list of
configured backends). On clean shutdown the manifest MUST be deleted.

#### Scenario: Manifest written on listen

- **GIVEN** no manifest exists at the path
- **WHEN** `artagon-acp-server` completes initialization
- **THEN** the file exists with mode 0o600 under a 0o700 parent dir
  AND its `pid` field equals the server's process pid

#### Scenario: Manifest cleaned on close

- **GIVEN** a manifest exists for a running server
- **WHEN** the server receives SIGTERM and exits cleanly
- **THEN** the manifest file no longer exists

### Requirement: Stale manifest detection

Callers SHALL treat the endpoint manifest as stale when the named
pid is dead OR the file's uid does not match the current process
uid. Stale manifests MUST be deleted (when uid matches) or refused
(when uid differs).

#### Scenario: Dead pid → manifest treated as stale

- **GIVEN** a manifest exists with `pid` 12345
- **AND** PID 12345 is not a live process owned by the current uid
- **WHEN** a caller reads the manifest
- **THEN** the caller proceeds as if the manifest does not exist

### Requirement: MCP server discovery

When `--mcp-aggregation` is on (default), the server SHALL discover
MCP servers from each of three per-backend config locations:
`~/.claude/settings.json` `mcpServers`, `~/.codex/config.toml`
`[mcp_servers.*]`, `~/.gemini/settings.json` `mcpServers`. Discovery
MUST tolerate missing files and invalid sections without aborting
startup.

#### Scenario: All three configs present

- **GIVEN** each per-backend config registers a unique MCP server
- **WHEN** discovery runs at server startup
- **THEN** the server's tool catalog union includes all three

#### Scenario: Missing config tolerated

- **GIVEN** `~/.codex/config.toml` does not exist
- **WHEN** discovery runs
- **THEN** discovery completes without error
  AND the codex slot in the discovery result is empty
  AND the other backends' MCP servers are still discovered

### Requirement: MCP namespace prefix

The aggregator SHALL expose every MCP tool, resource, and prompt
with namespace prefix `<server>:<name>`. The aggregator MUST NOT
silently merge identically-named entries from different MCP servers.

#### Scenario: Namespace disambiguation

- **GIVEN** server `claude-fs` has tool `read_file`
- **AND** server `codex-fs` also has tool `read_file`
- **WHEN** an ACP client requests `tools/list`
- **THEN** the response contains both `claude-fs:read_file` and
  `codex-fs:read_file` as distinct entries

### Requirement: MCP cross-backend routing

The aggregator SHALL route `tools/call`, `resources/read`, and
`prompts/get` invocations to the MCP server hosting the namespaced
target, regardless of which backend originally registered the
hosting server.

#### Scenario: Cross-backend invocation

- **GIVEN** server `claude-fs:read_file` is hosted via claude's MCP
  config
- **AND** the active session is bound to gemini
- **WHEN** the client invokes `tools/call` with name
  `claude-fs:read_file`
- **THEN** the aggregator routes the call to the claude-config-
  registered MCP server
- **AND** the result returns to the gemini-bound session as a
  `tool_result`

### Requirement: MCP allow/deny configuration

The server SHALL honor an allow/deny list at
`$XDG_CONFIG_HOME/artagon-agent-cli-plugin/mcp-allowlist.json`.
When an entry has `"enabled": false`, the corresponding MCP server's
tools/resources/prompts MUST NOT appear in the aggregated catalog
nor be routable.

#### Scenario: Disabled server hidden

- **GIVEN** `mcp-allowlist.json` has `{"servers": [{"name":
"claude-fs", "enabled": false}]}`
- **WHEN** an ACP client requests `tools/list`
- **THEN** no `claude-fs:*` tools appear

### Requirement: ACP-level authentication

The server SHALL support the same `--auto-key` /
`--api-key{,-file}` auth flags as `bin/artagon-openai-server.mjs`.
When auth is enabled, every ACP request MUST present a valid bearer
token via the ACP `authenticate` method or a per-request header
(transport-dependent).

#### Scenario: Unauthenticated request rejected

- **GIVEN** the server runs with `--auto-key`
- **AND** the auto-provisioned key is K
- **WHEN** an ACP client connects and sends `session/prompt` without
  authenticating
- **THEN** the server replies with JSON-RPC error
  `code: -32001, message: "authentication required"`

#### Scenario: Authenticated request succeeds

- **GIVEN** the server runs with `--auto-key`
- **AND** the auto-provisioned key is K
- **WHEN** an ACP client sends `authenticate` with bearer K and
  then `session/prompt`
- **THEN** the second request succeeds

### Requirement: Per-turn cost telemetry

Every turn handled through the ACP server SHALL append a cost record
to `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` with
`transport: "acp-server"` and `mcp_tools_used: string[]` reflecting
namespaced tool names invoked during the turn.

#### Scenario: Cost record per turn

- **GIVEN** the server has handled one ACP `session/prompt` against
  the codex backend
- **WHEN** the operator inspects `cost.jsonl`
- **THEN** the most recent line has `backend: "codex"` AND
  `transport: "acp-server"` AND a numeric `usage` block

#### Scenario: mcp_tools_used populated

- **GIVEN** a turn called the MCP tool `claude-fs:read_file` once
- **WHEN** the cost record for that turn is read
- **THEN** `mcp_tools_used` contains `["claude-fs:read_file"]`

### Requirement: Operator-friendly degradation

The server SHALL respond with a JSON-RPC error containing an
actionable message when a request is routed to a backend whose
adapter health is `dead`. The server MUST NOT silently re-route the
request to a different backend.

#### Scenario: Dead backend → actionable error

- **GIVEN** the codex backend's health is `dead`
- **WHEN** a client sends `session/prompt` with `model: "gpt-5"`
- **THEN** the server replies with a JSON-RPC error message that
  names the backend AND suggests restarting the server

### Requirement: Phase-0 broker awareness (independent quick win)

`runStatelessTurn(BACKEND_NAMES.GEMINI, options)` SHALL detect an
existing gemini broker session in `options.cwd`'s state dir and
route the turn through the broker's Unix socket when alive AND
owned by the current uid. On any broker-connect error, the
dispatcher MUST fall back to the cold-start `runGeminiPrint` path
with a single one-shot stderr warning.

#### Scenario: Broker present and healthy

- **GIVEN** a gemini broker is running for cwd C with socket S and
  pid P alive AND owned by current uid
- **WHEN** `runStatelessTurn(GEMINI, {cwd: C, prompt: "..."})` is
  called
- **THEN** the dispatcher connects via S
  AND the cost record has `transport: "broker"`

#### Scenario: Stale broker → fall back

- **GIVEN** `broker-session.json` exists with pid P
- **AND** P is not a live process
- **WHEN** the dispatcher probes the broker
- **THEN** the probe returns null
  AND `runGeminiPrint` runs instead
  AND a single stderr warning fires once per process lifetime
