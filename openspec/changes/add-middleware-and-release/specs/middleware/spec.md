# Spec Delta: middleware

## ADDED Requirements

### Requirement: Middlewares compose around AcpSession

The plugin SHALL provide a `composeMiddleware(middlewares)` function that
takes an ordered list of middleware factories and returns a function
wrapping any `AcpSession`. Composition order is left-to-right: the first
middleware is outermost (sees calls before they reach the inner
session).

#### Scenario: Composed wrapper is transparent

- **GIVEN** a `MockBackend` instance
- **AND** the identity middleware composed around it
- **WHEN** the conformance suite runs against the wrapped session
- **THEN** all conformance tests pass
- **AND** observable behavior is identical to the unwrapped backend

#### Scenario: Middleware chain enforces redaction-first

- **GIVEN** a composition where redaction is at index 1 (not 0)
- **WHEN** the composition is built in development mode (NODE_ENV !== 'production')
- **THEN** `composeMiddleware` throws `MiddlewareOrderError`
- **AND** the error message identifies the misorder
- **AND** the message references `docs/middleware-architecture.md`

#### Scenario: Middleware chain warns on production misorder

- **GIVEN** the same misorder
- **WHEN** the composition is built in production mode
- **THEN** a `warn` log line is emitted
- **AND** composition succeeds (does not throw)
- **AND** rationale: avoid breaking existing users on a config bug;
  development-mode strictness catches it during dev

### Requirement: Redaction strips known secret patterns

The plugin SHALL provide redaction middleware that strips secret
patterns from outbound prompts, captured tool outputs, and any payloads
passed to subsequent middlewares (audit, cost, observability). Default
patterns SHALL include:

- API key shapes: `sk-...`, `ant-...`, `AIza...`, OpenAI/Anthropic/
  Google patterns matching their documented prefixes
- Bearer tokens in `Authorization` headers
- PEM-encoded blocks (private keys, certificates)
- URLs with embedded credentials: `https://user:pass@host/`

Configurable additional patterns SHALL be loaded from
`~/.acp-plugins/redaction.json` if present.

#### Scenario: API key in prompt is redacted

- **GIVEN** a prompt containing `sk-abcdef0123456789`
- **WHEN** the prompt passes through redaction middleware
- **THEN** the outbound prompt sent to the inner session contains
  `[REDACTED:apikey]` in place of the literal value
- **AND** the original value does not appear anywhere in audit log
  or cost middleware records

#### Scenario: Property-level guarantee

- **GIVEN** the property test that generates random text with
  embedded secret patterns
- **WHEN** redaction processes 1000 randomly-generated samples
- **THEN** for every sample, the original secret string does not
  appear in the redaction output
- **AND** non-secret content is preserved verbatim

#### Scenario: Custom redaction patterns

- **GIVEN** `~/.acp-plugins/redaction.json` with
  `{ "patterns": [{ "regex": "INTERNAL-\\d{6}", "replacement": "[INTERNAL-ID]" }] }`
- **WHEN** redaction loads at startup
- **THEN** the custom pattern applies in addition to defaults
- **AND** input `INTERNAL-123456` becomes `[INTERNAL-ID]`

### Requirement: Audit log persists redacted records to disk

The plugin SHALL provide audit middleware that writes one JSONL line
per significant event (prompt, tool call, tool result, completion,
error, health transition) to a per-session file at
`~/.acp-plugins/audit/<session-id>/audit.jsonl`. Audit records SHALL
contain only redacted content (the audit middleware operates on the
output of redaction; never on raw input).

#### Scenario: Audit record written

- **GIVEN** a session with redaction + audit middlewares
- **WHEN** the user submits a prompt and receives a tool-call event
- **THEN** the audit file contains at least two lines
- **AND** each line is valid JSON
- **AND** each line contains `t`, `sessionId`, `kind`, `payload`
- **AND** `payload` content shows redacted strings, not original

#### Scenario: Daily rotation

- **GIVEN** an active audit log on day N
- **WHEN** the local clock crosses midnight to day N+1
- **THEN** the day-N file is gzipped to `audit.jsonl.<YYYY-MM-DD>.gz`
- **AND** new records on day N+1 go to a fresh `audit.jsonl`

#### Scenario: Retention cleanup

- **GIVEN** retention configured as 90 days
- **WHEN** the cleanup job runs
- **THEN** files older than 90 days are removed
- **AND** files within 90 days are preserved
- **AND** the cleanup logs each file removed

### Requirement: Cost tracking persists per-session metrics

The plugin SHALL provide cost middleware that accumulates token usage
and estimated USD cost per session. Metrics SHALL be persisted to
`~/.acp-plugins/sessions/<session-id>/metrics.json`. The file SHALL be
updated after each prompt completion. Cost tracking SHALL be marked as
informational; provider billing is the authority.

#### Scenario: Metrics accumulate over multiple prompts

- **GIVEN** a session with three prompts in sequence
- **WHEN** the third prompt completes
- **THEN** `metrics.json` contains accumulated tokensIn, tokensOut,
  and estimatedUsd from all three prompts
- **AND** `counts.prompts` equals 3

#### Scenario: /agent:cost lists recent sessions

- **GIVEN** five completed sessions across different backends
- **WHEN** the user runs `/agent:cost`
- **THEN** the output lists each session with backend, model, total
  tokens, estimated USD, and start time
- **AND** sessions are sorted by start time (newest first)

#### Scenario: /agent:cost session detail

- **GIVEN** a specific session ID
- **WHEN** the user runs `/agent:cost <session-id>`
- **THEN** the output includes the full metrics record
- **AND** includes a disclaimer that values are informational

### Requirement: Retry middleware retries transient errors

The plugin SHALL provide retry middleware that retries on transient
error kinds: `rate-limited`, `network`. Retry SHALL NOT apply to:
`auth-required`, `internal`, `aborted`. Default budget: 3 retries
with exponential backoff (1s, 2s, 4s).

#### Scenario: Retry on rate-limit succeeds

- **GIVEN** a backend that fails with `kind: 'rate-limited'` on
  first call and succeeds on second
- **WHEN** the retry middleware processes the prompt
- **THEN** the first failure is observed
- **AND** after 1 second, a second attempt is made
- **AND** the prompt resolves with the success response
- **AND** an OTel span event `retry.attempt` is emitted with `attempt: 1`

#### Scenario: No retry on auth error

- **GIVEN** a backend that fails with `kind: 'auth-required'`
- **WHEN** retry middleware processes the prompt
- **THEN** the error propagates immediately
- **AND** no retry attempts are made

#### Scenario: Retry budget exhausted

- **GIVEN** a backend that consistently fails with rate-limit
- **WHEN** retry processes the prompt
- **THEN** 3 retries are attempted (4 total calls)
- **AND** the final error includes `retriesAttempted: 3`
- **AND** the error kind remains `rate-limited`

#### Scenario: Per-call retry disable

- **GIVEN** a slash command invoked with `--no-retry`
- **WHEN** the call reaches retry middleware
- **THEN** retry is skipped for this call
- **AND** errors propagate immediately

### Requirement: Fallback middleware switches models on persistent failure

The plugin SHALL provide fallback middleware that, on persistent
failure (after retry exhausts or for non-retryable model-overload
errors), invokes the next model alias in the backend's configured
fallback chain.

#### Scenario: Opus over-capacity falls back to Sonnet

- **GIVEN** Claude backend with fallback chain
  `['opus', 'sonnet', 'haiku']`
- **AND** the user invokes `/claude:rescue --model opus`
- **WHEN** the opus request fails with model-overload
- **THEN** retry middleware exhausts retries
- **AND** fallback middleware invokes the same prompt with
  `model: 'sonnet'`
- **AND** the response surfaces to the user
- **AND** cost middleware records BOTH attempts as separate entries

#### Scenario: Per-call fallback disable

- **GIVEN** a slash command with `--no-fallback`
- **WHEN** opus fails persistently
- **THEN** the failure surfaces immediately without trying sonnet
- **AND** the user sees the original error

### Requirement: Cache middleware is opt-in and write-safe

The plugin SHALL provide cache middleware that, when enabled per
command, hashes (prompt + serialized context + git HEAD) into a cache
key, and returns cached responses for matching keys. Cache SHALL NOT
apply to commands with side effects.

The cacheable command allowlist SHALL include only:
- `/<backend>:review`
- `/<backend>:adversarial-review`

Other commands (`/<backend>:rescue`, slash commands invoking write tools)
SHALL never cache.

#### Scenario: Cache hit on identical inputs

- **GIVEN** a prior `/gemini:review --cache` invocation that produced
  a cached response
- **AND** the user runs the identical command again at the same git HEAD
- **WHEN** cache middleware processes the request
- **THEN** the cached response is returned without invoking the backend
- **AND** an info log records `cache: hit, key: <hash-prefix>`

#### Scenario: Cache miss on changed git HEAD

- **GIVEN** a prior cached response at commit A
- **WHEN** the user invokes the same command after git checkout to commit B
- **THEN** cache key differs (HEAD changed)
- **AND** the backend is invoked
- **AND** the new response is stored under the new key

#### Scenario: Cache never applies to rescue

- **GIVEN** a `/codex:rescue --cache` invocation (user attempts opt-in)
- **WHEN** the command starts
- **THEN** cache middleware logs a warning that rescue is not cacheable
- **AND** proceeds without caching
- **AND** does not consult any cache entry

#### Scenario: Cache TTL expiration

- **GIVEN** a cached response older than TTL (default 7 days)
- **WHEN** cache middleware looks up the key
- **THEN** the entry is treated as a miss
- **AND** the stale entry is deleted
- **AND** the backend is invoked

## ADDED Requirements (Composition contract)

### Requirement: Default composition order is fixed and documented

The plugin SHALL apply middlewares in the order:
`[redaction, audit, cost, retry, fallback, cache]`. This order SHALL be
documented in `docs/middleware-architecture.md` with rationale per
position. Reordering SHALL require:

- updating the spec
- documenting the deviation rationale in the change proposal
- explicit opt-in via configuration (not the default)

#### Scenario: Default order applied without configuration

- **GIVEN** a fresh plugin install with no middleware configuration
- **WHEN** a session starts
- **THEN** the active middleware chain is the default order above
- **AND** the chain is logged at debug level on startup

### Requirement: Retry middleware does not retry past tool execution

Retry middleware SHALL NOT retry a prompt once any tool_call
notification has been emitted by the inner session for that prompt.
Tool execution may have side effects; retrying a prompt that has
already triggered tool calls would re-execute side effects.

#### Scenario: Failure before any tool call retries

- **GIVEN** a prompt that fails with rate-limit before any tool_call
  has been emitted
- **WHEN** retry middleware processes the failure
- **THEN** the retry proceeds (per the standard backoff)
- **AND** the prompt eventually resolves on a retry attempt

#### Scenario: Failure after a tool call does NOT retry

- **GIVEN** a prompt that has emitted at least one tool_call
- **WHEN** the prompt subsequently fails (e.g., backend rate-limits
  on a follow-up message)
- **THEN** retry middleware DOES NOT retry
- **AND** the failure propagates to the user immediately
- **AND** an info log records "retry skipped: tool calls already
  executed"

#### Scenario: Tool-emission tracking per prompt

- **GIVEN** a session running multiple sequential prompts
- **WHEN** prompt A emits tool calls and completes; prompt B then
  fails before any tool emissions
- **THEN** prompt B is eligible for retry (per-prompt tracking, not
  per-session)

### Requirement: Cache key includes content length and version marker

The cache key for a request SHALL be the concatenation of:
- the SHA256 hex digest of canonical-JSON(prompt + serialized context)
- the byte length of canonical-JSON(prompt + serialized context)
- the git HEAD commit SHA at request time
- the plugin version (from `package.json`)

Cached entries SHALL include the plugin version that wrote them.
Reads SHALL ignore entries written by an incompatible plugin version.

#### Scenario: Identical prompt+context different lengths cannot collide

- **GIVEN** two distinct prompt+context pairs A and B with
  hypothetical SHA256 collision
- **WHEN** the cache keys are computed
- **THEN** the keys differ because the byte lengths differ (or, if
  identical lengths, the inputs are byte-identical and the cache is
  correct)

#### Scenario: Cache reads check version compatibility

- **GIVEN** a cache entry written by plugin version 2.0.0
- **AND** the current plugin version is 3.0.0 with incompatible cache
  schema
- **WHEN** the cache reads the entry
- **THEN** the entry is treated as a miss
- **AND** the entry is deleted to free space

### Requirement: Plugin data directories use restrictive permissions

All directories created under `~/.acp-plugins/` SHALL be created with
mode `0700` (owner-only access). All files written under
`~/.acp-plugins/` SHALL be created with mode `0600` (owner read/write
only). The plugin SHALL NOT rely on the user's umask for these
permissions; the plugin SHALL explicitly set the mode.

#### Scenario: Audit log file is owner-only

- **GIVEN** a fresh session that produces audit records
- **WHEN** `~/.acp-plugins/audit/<session-id>/audit.jsonl` is created
- **THEN** the file mode is `0600`
- **AND** other local users cannot read the file

#### Scenario: Cache file is owner-only

- **GIVEN** a cache write
- **WHEN** the cache file is created
- **THEN** the file mode is `0600`

#### Scenario: Directories created with 0700

- **GIVEN** any new subdirectory under `~/.acp-plugins/`
- **WHEN** the directory is created
- **THEN** the directory mode is `0700`

#### Scenario: Existing files with permissive modes are tightened

- **GIVEN** a file under `~/.acp-plugins/` with permissive mode
  (e.g., `0644`) due to a prior bug or external modification
- **WHEN** the plugin opens the file
- **THEN** the plugin attempts to chmod to `0600`
- **AND** if chmod fails (e.g., on Windows), the plugin logs a warning
- **AND** the operation continues

### Requirement: Audit log session directory is bounded

The plugin SHALL cap the number of active session directories under
`~/.acp-plugins/audit/`. Default cap: 2000 directories. When the cap
is exceeded, the oldest directory (by mtime) SHALL be removed.

#### Scenario: Cap enforced on directory creation

- **GIVEN** `~/.acp-plugins/audit/` contains 2000 session directories
- **WHEN** a new session creates its audit directory
- **THEN** the oldest directory (by modification time) is removed
- **AND** the new directory is created
- **AND** an info log records the eviction

#### Scenario: Cap configurable

- **GIVEN** the user configures cap via env or config file
  (`ACP_AUDIT_DIR_CAP=500`)
- **WHEN** the plugin starts
- **THEN** the configured cap applies

#### Scenario: Cap interacts with retention

- **GIVEN** retention is 90 days and cap is 2000 directories
- **WHEN** a session reaches the cap before retention triggers
- **THEN** cap-based eviction runs first
- **AND** retention cleanup runs as a separate concern (daily)
