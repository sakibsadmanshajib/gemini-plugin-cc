# Spec Delta: backend-gemini

## ADDED Requirements

### Requirement: Gemini backend declared with CLI transport

The plugin SHALL provide a `geminiBackend` declaration that specifies:
- `name: 'gemini'`
- `modelAliases` mapping short names to canonical Gemini model IDs
- `transports.cli` factory returning a `CliTransport` configured for
  `gemini --acp`
- `defaultTransport: 'cli'`
- `setupHints` describing the auth flow

#### Scenario: Default invocation uses CLI transport

- **GIVEN** the plugin loads `geminiBackend`
- **AND** no transport override is configured
- **WHEN** a session is created
- **THEN** `geminiBackend.transports.cli(config)` is invoked
- **AND** a `CliTransport` is returned

#### Scenario: Model alias resolution

- **GIVEN** a slash command argument `--model pro`
- **WHEN** the resolver consults `geminiBackend.modelAliases`
- **THEN** the alias `pro` resolves to the canonical Gemini Pro model ID
- **AND** the canonical ID is passed to the backend

### Requirement: Gemini backend handles existing CLI auth

The Gemini backend SHALL inherit the user's existing Gemini CLI
authentication (`!gemini` interactive login or `GEMINI_API_KEY` env var).
The backend SHALL NOT require additional configuration when the user has
already authenticated via the Gemini CLI.

#### Scenario: User logged in via Gemini CLI

- **GIVEN** the user has previously run `!gemini` and authenticated
- **WHEN** the plugin spawns `gemini --acp`
- **THEN** the subprocess uses the existing OAuth credentials from
  `~/.gemini/oauth_creds.json` (or platform equivalent)
- **AND** no additional env vars are required

#### Scenario: API key user has no interactive login

- **GIVEN** `GEMINI_API_KEY` is set in the environment
- **AND** no interactive auth has been performed
- **WHEN** the plugin spawns `gemini --acp`
- **THEN** the subprocess inherits `GEMINI_API_KEY`
- **AND** authenticates via API key

### Requirement: Gemini backend recognizes Gemini-specific errors

The plugin SHALL map Gemini-specific error responses to the appropriate
health labels:

- rate-limit responses → `rate_limited`
- auth failures (401, 403) → `auth_required`
- transport-level errors → `worker_missing` or `broker_unhealthy`

#### Scenario: Rate-limit error transitions health

- **GIVEN** the subprocess emits an error with Gemini's rate-limit
  message shape
- **WHEN** the backend's error handler processes it
- **THEN** the health label transitions to `rate_limited`
- **AND** the recommended-action message references waiting or model
  switching

#### Scenario: Auth error prompts re-login

- **GIVEN** the subprocess returns a 401-equivalent error
- **WHEN** the error reaches the backend
- **THEN** the health label is `auth_required`
- **AND** the recommended action is to re-run setup

### Requirement: Gemini backend slash commands operate unchanged

The Gemini slash commands SHALL preserve their user-visible behavior from
prior plugin versions — including `/gemini:review`,
`/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`,
`/gemini:result`, `/gemini:cancel`, and `/gemini:setup` — except that
internal implementation now flows through `geminiBackend` and
`CliTransport`.

#### Scenario: Existing fixture replays succeed

- **GIVEN** a fixture recorded from the prior implementation
- **WHEN** the fixture is replayed against the new implementation
- **THEN** outbound messages match (modulo timestamps and request IDs)
- **AND** user-visible side effects (job state files, log output) match
