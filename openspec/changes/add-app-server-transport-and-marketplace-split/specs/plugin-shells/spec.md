# Spec Delta: plugin-shells

## ADDED Requirements

### Requirement: Each backend has its own Claude Code plugin

The repo SHALL ship three Claude Code plugins under `plugins/`:
`gemini`, `codex`, `claude`. Each plugin SHALL be independently
installable via `claude plugin install <name>@artagon-acp`.

#### Scenario: Independent installation

- **GIVEN** a user with no plugins installed
- **WHEN** the user runs `claude plugin install codex@artagon-acp`
- **THEN** only the Codex plugin is installed
- **AND** `gemini` and `claude` plugin commands are not available
- **AND** the user can later install `gemini@artagon-acp` without
  re-installing Codex

### Requirement: Each plugin's manifest declares its slash commands

Each plugin SHALL contain `.claude-plugin/plugin.json` declaring the
plugin's name, version, description, and slash command surface. Each
slash command SHALL have a corresponding `commands/<verb>.md` file.

#### Scenario: Gemini plugin manifest

- **GIVEN** the `gemini` plugin
- **WHEN** Claude Code loads the plugin
- **THEN** the slash commands `/gemini:review`, `/gemini:rescue`,
  `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel`, `/gemini:setup` are available
- **AND** each command's behavior is implemented in the plugin's
  `scripts/companion.mjs`

### Requirement: Plugin shells share a common library

Each plugin's `package.json` SHALL declare a workspace dependency on
`@artagon/acp-plugin-lib` (`workspace:*`). Plugin shells SHALL contain
only thin orchestration code; backend logic, transport logic, and
observability live in the shared library.

#### Scenario: Bug fix in shared library propagates

- **GIVEN** a bug fixed in `@artagon/acp-plugin-lib`
- **WHEN** the library is published with a version bump
- **THEN** all three plugins receive the fix on next install
- **AND** the fix does not require changes to plugin shell code

### Requirement: Backend slash commands operate identically across plugins

The slash command set SHALL be uniform across plugins (with
backend-specific naming):

- `/<backend>:review` — read-only review
- `/<backend>:adversarial-review` — challenge review
- `/<backend>:rescue` — task delegation
- `/<backend>:status` — list jobs
- `/<backend>:result` — fetch finished job output
- `/<backend>:cancel` — cancel active job
- `/<backend>:setup` — auth and configuration

Backend-specific extensions (e.g., differing model alias names) SHALL
be documented in `docs/backends/<backend>.md`.

#### Scenario: Cross-backend command parity

- **GIVEN** a user familiar with `/gemini:rescue`
- **WHEN** the user runs `/codex:rescue` or `/claude:rescue`
- **THEN** the syntax and flag semantics match
- **AND** model aliases are documented in each backend's docs

## ADDED Requirements (Backwards Compatibility)

### Requirement: Old install URL continues to work

Users who installed via the old `gemini-plugin-cc` install URL SHALL
continue to work. After repo rename, the marketplace SHALL be
discoverable from both old and new URLs (via GitHub redirect).

#### Scenario: Old marketplace URL redirects

- **GIVEN** a user runs
  `claude plugin marketplace add sakibsadmanshajib/gemini-plugin-cc`
  (old fork) or any pre-rename URL
- **WHEN** Claude Code resolves the URL
- **THEN** GitHub returns a redirect to the new repo
- **AND** the marketplace loads from the new location
- **AND** the user can install the `gemini` plugin from the new
  marketplace

### Requirement: Existing /gemini:* slash commands preserved

The `/gemini:*` slash command surface SHALL continue to work. Users
upgrading SHALL see no breaking changes to their existing workflows.

#### Scenario: Upgrade preserves commands

- **GIVEN** a user on the prior plugin version using `/gemini:review`
- **WHEN** the user upgrades to the new multi-plugin version
- **THEN** `/gemini:review` continues to work identically
- **AND** any persisted job state from the prior version remains
  readable

### Requirement: Workspace migration window has a freeze policy

During the implementation window of this proposal, modifications to
`lib/` (the source files being relocated) by parallel PRs SHALL be
restricted. The proposal owner SHALL post a freeze notice on the
tracking issue at the start of T1.1; the freeze SHALL be lifted once
T1.4 (verification of `pnpm install` symlinking) completes.

#### Scenario: Freeze notice posted

- **GIVEN** the proposal owner begins T1.1
- **WHEN** the workspace activation PR is opened
- **THEN** the owner comments on the tracking issue: "freeze on
  `lib/` modifications until workspace migration completes"
- **AND** existing in-flight PRs touching `lib/` are paused or rebased
  after the migration

#### Scenario: Freeze lifted on completion

- **GIVEN** workspace migration completed (T1.4 verified)
- **WHEN** the owner posts the unfreeze notice
- **THEN** subsequent PRs touching `lib/src/` (now the source path)
  are unblocked
