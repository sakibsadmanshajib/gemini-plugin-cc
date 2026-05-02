# Spec Delta: marketplace

## ADDED Requirements

### Requirement: Marketplace declares all three plugins

The repo SHALL contain `.claude-plugin/marketplace.json` at the root,
declaring all three plugins. The marketplace SHALL be installable via
`claude plugin marketplace add artagon/acp-plugins-cc` (post-rename).

#### Scenario: Marketplace lists three plugins

- **GIVEN** the marketplace JSON
- **WHEN** Claude Code reads it
- **THEN** the marketplace exposes plugins named `gemini`, `codex`,
  and `claude`
- **AND** each plugin's `source.path` points to the corresponding
  `plugins/<name>/` directory

### Requirement: Marketplace install commands documented

The repo's README SHALL document install commands for each plugin:

```
claude plugin marketplace add artagon/acp-plugins-cc
claude plugin install gemini@artagon-acp
claude plugin install codex@artagon-acp
claude plugin install claude@artagon-acp
```

#### Scenario: User follows README install

- **GIVEN** a new user reading the README
- **WHEN** the user copies and runs the install commands
- **THEN** the marketplace is added
- **AND** all three plugins install without errors
- **AND** the user sees three slash command namespaces:
  `/gemini:*`, `/codex:*`, `/claude:*`

## ADDED Requirements (v1 Deprecation)

### Requirement: v1 mode preserved for 30 calendar days

After the v1/v2 default flip, `ACP_PLUGIN_VERSION=v1` SHALL continue to
work for 30 calendar days from the flip date. The plugin SHALL emit a
one-time-per-session warning indicating the v1 removal date.

#### Scenario: User opts into v1 within runway

- **GIVEN** a user sets `ACP_PLUGIN_VERSION=v1` 15 days after the flip
- **WHEN** the plugin starts
- **THEN** v1 behavior applies (the prior single-Gemini-plugin shape)
- **AND** a `warn` log line emits once per session: "v1 mode deprecated;
  removed on <DATE>"

#### Scenario: Within 7 days of removal, warning escalates

- **GIVEN** the configured removal date is 7 or fewer days away
- **WHEN** a v1 session starts
- **THEN** the warning escalates to include "ACTION REQUIRED" prefix
- **AND** the message includes a link to the migration guide

### Requirement: Rollback procedure tested before flip

The v1/v2 flip PR SHALL NOT be merged until a documented rollback
procedure has been dry-run tested. The rollback procedure SHALL be a
single-revert PR; tested in a staging environment.

#### Scenario: Rollback dry-run

- **GIVEN** the v1/v2 flip PR is open
- **WHEN** the project owner executes the rollback dry-run
- **THEN** the dry-run reverts the flip in a staging branch
- **AND** confirms v1 behavior is restored
- **AND** the dry-run results are documented in
  `docs/v2-rollback-procedure.md`

## ADDED Requirements (Marketplace Cache)

### Requirement: Marketplace cache invalidation documented

The plugin SHALL document how Claude Code caches `marketplace.json` and
how users can invalidate stale cache. The documentation SHALL list the
cache file location and the command to refresh.

#### Scenario: User experiences stale marketplace cache

- **GIVEN** a user with a previously installed marketplace
- **AND** the marketplace was updated upstream
- **WHEN** the user runs `claude plugin install <new-plugin>`
- **AND** the new plugin is not found
- **THEN** the user consults `docs/troubleshooting.md`
- **AND** finds the cache invalidation command
- **AND** the install succeeds after invalidation
