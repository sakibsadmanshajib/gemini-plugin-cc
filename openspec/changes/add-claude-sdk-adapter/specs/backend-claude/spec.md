# Spec Delta: backend-claude

## ADDED Requirements

### Requirement: Claude backend declared with SDK transport only

The plugin SHALL provide a `claudeBackend` declaration with a `sdk`
transport using `@anthropic-ai/claude-agent-sdk`. No CLI transport
SHALL be declared (no native ACP CLI exists for Claude). The default
transport SHALL be `sdk`.

#### Scenario: Default transport is SDK

- **GIVEN** the plugin loads `claudeBackend`
- **WHEN** a session is created
- **THEN** the SDK transport is used
- **AND** no Claude subprocess is spawned

#### Scenario: CLI transport not available

- **GIVEN** the plugin loads `claudeBackend`
- **WHEN** the contributor inspects `claudeBackend.transports`
- **THEN** only `sdk` is present
- **AND** `cli` is undefined

### Requirement: Claude SDK reads existing credentials

The Claude SDK transport SHALL inherit credentials from
`~/.claude/.credentials.json` when no explicit `apiKey` is configured.

#### Scenario: User authenticated via Claude CLI

- **GIVEN** the user has previously run `claude /login`
- **AND** `~/.claude/.credentials.json` exists with valid OAuth tokens
- **WHEN** the plugin instantiates the Claude SDK adapter without
  explicit auth
- **THEN** the first request authenticates successfully

### Requirement: Claude translator covers core message types

The Claude translator SHALL convert at minimum these SDK message types
to ACP `session/update` notifications:

- `assistant` content blocks → `agent_message_chunk`
- `tool_use` blocks → `tool_call`
- `tool_result` blocks → `tool_result`
- `result` (final message) → completion marker

The translator SHALL log untranslatable events at debug and return null.

#### Scenario: Assistant message translates to chunk

- **GIVEN** an SDK event of shape
  `{ type: 'assistant', content: [{ type: 'text', text: 'hello' }] }`
- **WHEN** the translator processes it
- **THEN** the translator returns an ACP `session/update` with kind
  `agent_message_chunk` and content `'hello'`

#### Scenario: Tool use translates to tool_call

- **GIVEN** an SDK event with a `tool_use` block:
  `{ type: 'tool_use', id: 'abc', name: 'Read', input: { file: 'x.md' } }`
- **WHEN** the translator processes it
- **THEN** the translator returns an ACP `session/update` with kind
  `tool_call`, name `Read`, args `{ file: 'x.md' }`, and id `abc`

#### Scenario: Unknown event type returns null

- **GIVEN** an SDK event of an unknown type (e.g., `assistant_v2`)
- **WHEN** the translator processes it
- **THEN** the translator returns null
- **AND** a debug log records the unknown type
- **AND** the degraded-mode counter increments

### Requirement: Claude backend supports degraded mode

The Claude backend SHALL operate in a degraded mode when the translator encounters event types it cannot translate: text streaming is preserved, while tool calls and rich features that depend on untranslated events surface as warnings rather than functional failures.

#### Scenario: Future event type triggers degraded mode

- **GIVEN** the SDK introduces a new event type the translator does not
  recognize
- **WHEN** that event arrives during a session
- **THEN** a `warn` log is emitted with the event type
- **AND** the degraded-mode counter increments
- **AND** the session continues; the user receives partial output
- **AND** subsequent messages of recognized types continue to translate

#### Scenario: Degraded-mode count surfaced in tracking

- **GIVEN** the degraded-mode counter exceeds a threshold (10 events
  within an hour)
- **WHEN** the threshold is crossed
- **THEN** a tracking issue is created or updated with the events
  observed
- **AND** the affected backend's health includes a degraded indicator

### Requirement: Permission modes map to ACP request flow

The plugin SHALL map Claude SDK permission modes to ACP behavior:

- `default` — every tool call surfaces a `session/request_permission`
  to the client
- `acceptEdits` — file-edit tool calls auto-approved; other tools
  request permission
- `bypassPermissions` — all tool calls auto-approved (for E2E lanes
  only; SHALL NOT be the default)

#### Scenario: Default mode requests permission

- **GIVEN** `claudeBackend` configured with `permissionMode: 'default'`
- **WHEN** the SDK requests a tool call
- **THEN** the backend emits an ACP `session/request_permission`
- **AND** awaits the client's decision before proceeding

#### Scenario: AcceptEdits auto-approves file edits

- **GIVEN** `permissionMode: 'acceptEdits'`
- **AND** the SDK requests a `Edit` tool call
- **WHEN** the request reaches the backend
- **THEN** the backend auto-approves without surfacing
- **AND** the SDK proceeds with the edit

#### Scenario: BypassPermissions disabled by default

- **GIVEN** the plugin's default configuration
- **WHEN** a session is created
- **THEN** `permissionMode` is NOT `bypassPermissions`
- **AND** users who want bypass must set it explicitly with awareness
  of the implication

### Requirement: Claude E2E uses cost-controlled key

The Claude E2E test lane SHALL use a dedicated CI secret with provider-
side spend cap. Tests SHALL use only `claude-haiku-4-5` model unless a
specific test requires a more capable model and budget is allocated.

#### Scenario: E2E run on Haiku

- **GIVEN** the nightly Claude E2E job
- **WHEN** the job runs
- **THEN** all Claude requests use model `claude-haiku-4-5`
- **AND** monthly cost stays under the configured cap

### Requirement: Translator handles malformed events safely

The translator SHALL handle malformed Claude SDK events by returning null, logging at `error` level (not debug), incrementing the degraded-mode counter, and allowing the session to continue without crashing.

#### Scenario: Malformed assistant event

- **GIVEN** an SDK event of shape `{ type: 'assistant' }` with no
  `content` field
- **WHEN** the translator processes it
- **THEN** the translator returns null
- **AND** an `error` log line is emitted with the malformed event
  (redacted via observability redaction)
- **AND** the degraded-mode counter increments
- **AND** the session does not crash; subsequent events continue to
  process

#### Scenario: Malformed tool_use missing id

- **GIVEN** an SDK event of shape
  `{ type: 'tool_use', name: 'X', input: {} }` with no `id`
- **WHEN** the translator processes it
- **THEN** the translator returns null (cannot generate a valid ACP
  `tool_call` without an id)
- **AND** the degraded-mode counter increments
- **AND** an `error` log identifies the missing field

#### Scenario: Translator never throws

- **GIVEN** the property test that injects random objects as events
- **WHEN** the translator processes 1000 random objects
- **THEN** the translator never throws
- **AND** for inputs that are not valid SDK events, the translator
  returns null

### Requirement: Subagent permission denials surface without deadlock

The Claude backend SHALL surface subagent (delegated tool call) permission denials to the parent session through the SDK's `result` event. The translator SHALL emit a corresponding `tool_result` notification with the denial outcome. The parent session SHALL continue execution; no deadlock SHALL occur.

#### Scenario: Subagent tool denied

- **GIVEN** an active Claude session with `permissionMode: 'default'`
- **AND** a subagent invoking a Bash tool call
- **WHEN** the user denies the permission request
- **THEN** the SDK's `result` for the subagent shows the denial
- **AND** the translator emits a `tool_result` ACP notification with
  `outcome: 'denied'`
- **AND** the parent prompt continues processing subsequent events
- **AND** the prompt promise eventually resolves (no deadlock)

#### Scenario: Subagent denial does not crash session

- **GIVEN** a multi-tool subagent flow
- **WHEN** one tool is denied mid-flow
- **THEN** the session does not crash
- **AND** subsequent events from the same session continue to translate

### Requirement: Backend warns on permissive credentials-file permissions

The Claude backend SHALL inspect `~/.claude/.credentials.json` (or
platform equivalent) at first use. If the file mode is more permissive
than `0600`, or the file is a symlink to a path outside the user's
home directory, the backend SHALL emit a warning log. The backend
SHALL NOT fail the operation.

#### Scenario: World-readable credentials file

- **GIVEN** `~/.claude/.credentials.json` exists with mode `0644`
- **WHEN** the backend reads the file at first use
- **THEN** a `warn` log line is emitted referencing the permissive mode
- **AND** the recommended action: `chmod 600 ~/.claude/.credentials.json`
- **AND** the operation proceeds

### Requirement: bypassPermissions requires explicit opt-in with warning

`permissionMode: 'bypassPermissions'` SHALL only be activated by an
explicit user configuration choice (not by default and not by an
inherited config). When activated:

- the plugin logs a `warn` line at session start: "Tool calls
  auto-approved this session"
- a one-line user-visible message appears in the slash command output
  on session start
- after every 10 sessions in this mode, the plugin re-prompts the user
  to reconfirm via a `system` notification

#### Scenario: Plugin start with bypassPermissions logs warning

- **GIVEN** the user explicitly sets `permissionMode: 'bypassPermissions'`
- **WHEN** the plugin starts a session
- **THEN** a `warn` log line is emitted at session start
- **AND** the line includes the recommended hardening
  ("Set permissionMode to 'default' to require approval")

#### Scenario: Reconfirmation cycle

- **GIVEN** a user has run 10 sessions with bypassPermissions
- **WHEN** the 11th session starts
- **THEN** the plugin emits a `system` notification asking to
  reconfirm
- **AND** if the user does not reconfirm, the next session falls back
  to `default` mode

#### Scenario: bypassPermissions cannot be set as default in code

- **GIVEN** the plugin's source code
- **WHEN** the contributor inspects backend defaults
- **THEN** no default code path sets `permissionMode: 'bypassPermissions'`
- **AND** a CI lint rule (added in this proposal) flags any commit
  that introduces such a default
