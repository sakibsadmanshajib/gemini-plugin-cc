# Spec Delta: backend-codex

## ADDED Requirements

### Requirement: Codex backend declared with SDK and CLI transports

The plugin SHALL provide a `codexBackend` declaration with both `sdk`
and `cli` transport factories. The `sdk` transport SHALL use
`@openai/codex-sdk` (pinned exact version). The `cli` transport SHALL
use the Codex CLI in ACP mode when available.

#### Scenario: Default transport is SDK

- **GIVEN** the plugin loads `codexBackend`
- **WHEN** a session is created without a transport override
- **THEN** the SDK transport is used
- **AND** no Codex subprocess is spawned

#### Scenario: User overrides to CLI transport

- **GIVEN** a user explicitly selects the CLI transport
  (via slash command flag or settings)
- **WHEN** a session is created
- **THEN** the CLI transport is used
- **AND** a `codex` subprocess is spawned in ACP mode

### Requirement: Codex SDK reads existing auth file

The Codex SDK transport SHALL inherit credentials from
`~/.codex/auth.json` when no explicit `apiKey` is configured. When
explicit auth is provided, it SHALL override the file.

#### Scenario: User authenticated via Codex CLI

- **GIVEN** the user has previously run `codex login`
- **AND** `~/.codex/auth.json` exists with valid credentials
- **WHEN** the plugin instantiates `new Codex()` with no apiKey
- **THEN** the first request authenticates successfully
- **AND** no auth-related env vars are required

#### Scenario: Explicit API key overrides file

- **GIVEN** `~/.codex/auth.json` exists
- **AND** an explicit `OPENAI_API_KEY` is provided to the backend config
- **WHEN** the SDK runs
- **THEN** the explicit key is used
- **AND** `~/.codex/auth.json` is not consulted

#### Scenario: No credentials available

- **GIVEN** neither `~/.codex/auth.json` nor explicit key is present
- **WHEN** the first prompt is sent
- **THEN** the SDK throws an auth error
- **AND** the transport emits health `auth_required`
- **AND** the recommended action references `codex login` or env-var
  setup

### Requirement: Codex backend version-pins the SDK

The plugin SHALL pin `@openai/codex-sdk` to an exact version (no caret).
On startup, the backend SHALL assert the resolved SDK version matches
the pinned version. Mismatch SHALL emit a warning log but SHALL NOT
fail startup.

#### Scenario: Resolved version matches pinned

- **GIVEN** `package.json` pins `"@openai/codex-sdk": "1.2.3"`
- **AND** `pnpm install` resolves exactly 1.2.3
- **WHEN** the plugin starts
- **THEN** no version warning is emitted

#### Scenario: Resolved version drifts

- **GIVEN** the pinned version is 1.2.3 but `pnpm install` resolves
  1.2.4 (e.g., during local development)
- **WHEN** the plugin starts
- **THEN** a `warn` log line is emitted referencing the version drift
- **AND** the plugin continues to run

### Requirement: Codex backend handles SDK-specific errors

The Codex backend SHALL recognize Codex-specific error shapes and map
them to appropriate health labels and recommended actions:

- OpenAI rate-limit responses → `rate_limited`, recommend wait or
  switch to faster model
- OpenAI 401 responses → `auth_required`, recommend `codex login`
- ECONNREFUSED / network errors → `broker_unhealthy` (treat SDK as
  the broker for purposes of health label vocabulary)

#### Scenario: Rate-limit error transitions health

- **GIVEN** the SDK rejects a stream with an OpenAI rate-limit error
- **WHEN** the backend's normalizer processes the error
- **THEN** the health label is `rate_limited`
- **AND** the recommended action mentions `--model spark` (cheaper
  alternative) or waiting

### Requirement: Codex E2E gated on cost-controlled API key

The Codex E2E test lane SHALL use a dedicated CI secret with provider-
side budget cap configured. The cap SHALL be enforced at the OpenAI
account level, not relying on env-var gating alone. Test runs SHALL
use only inexpensive models (e.g., `spark`).

#### Scenario: E2E run on cheap model

- **GIVEN** the nightly E2E job
- **WHEN** the job runs Codex tests
- **THEN** all Codex requests use model `gpt-5.3-codex-spark`
  (or equivalent cheap model)
- **AND** the cumulative monthly cost stays under the configured cap

#### Scenario: E2E budget cap reached

- **GIVEN** the budget cap is reached mid-month
- **WHEN** an E2E run attempts an additional request
- **THEN** the request fails with a quota error from the provider
- **AND** the test gracefully reports the cap was hit
- **AND** the E2E job is marked as skipped, not failed

### Requirement: Backend warns on permissive auth-file permissions

The Codex backend SHALL inspect `~/.codex/auth.json` (or platform
equivalent) at first use. If the file mode is more permissive than
`0600`, or the file is a symlink, the backend SHALL emit a warning
log identifying the issue. The backend SHALL NOT fail the operation;
the warning is informational.

#### Scenario: World-readable auth file

- **GIVEN** `~/.codex/auth.json` exists with mode `0644`
- **WHEN** the backend reads the file at first use
- **THEN** a `warn` log line is emitted referencing the permissive mode
- **AND** the recommended action: `chmod 600 ~/.codex/auth.json`
- **AND** the operation proceeds (auth still works)

#### Scenario: Auth file is a symlink

- **GIVEN** `~/.codex/auth.json` is a symlink to another path
- **WHEN** the backend reads the file
- **THEN** a `warn` log line notes the symlink with the target
- **AND** the operation proceeds
