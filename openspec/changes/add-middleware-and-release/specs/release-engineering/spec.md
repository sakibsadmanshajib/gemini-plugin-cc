# Spec Delta: release-engineering

## ADDED Requirements

### Requirement: Versioning via changesets

The repo SHALL use `@changesets/cli` for versioning and changelog
generation. Each workspace package SHALL version independently. PRs
that modify code SHALL include a changeset; CI SHALL enforce this
with an opt-out for docs-only PRs.

#### Scenario: PR includes a changeset

- **GIVEN** a PR modifying a `.mjs` file under `lib/src/`
- **WHEN** CI runs the changeset check
- **THEN** the check succeeds only if `.changeset/*.md` includes a new
  entry referencing the modified package(s)

#### Scenario: Docs-only PR exempt

- **GIVEN** a PR that only modifies files under `docs/` or
  `*.md` at the repo root (excluding `lib/src/**/*.md`)
- **WHEN** CI runs the changeset check
- **THEN** the check skips the changeset requirement
- **AND** the PR can merge without a changeset

#### Scenario: Release flow generates changelog

- **GIVEN** several merged PRs each with changesets
- **WHEN** the maintainer runs `pnpm changeset version`
- **THEN** changesets are consumed
- **AND** affected packages have their `package.json` versions bumped
- **AND** `CHANGELOG.md` per package is generated/appended

### Requirement: Pinned SDK versions excluded from automated bumps

The repo SHALL exclude pinned vendor SDKs (`@openai/codex-sdk`,
`@anthropic-ai/claude-agent-sdk`, `@google/genai`) from Dependabot/
Renovate automated bumps. These versions SHALL be bumped manually by
maintainers after running translator snapshot tests against the new
version.

#### Scenario: Pinned SDK ignored by Renovate

- **GIVEN** a `renovate.json` with the pinned SDKs in the ignore list
- **WHEN** Renovate runs
- **THEN** no PR is opened for the pinned SDKs
- **AND** unpinned dependencies (Biome, vitest, typescript-native-preview)
  receive automated PRs as configured

### Requirement: Upstream drift CI runs nightly without failing main

A consolidated `upstream-drift.yml` workflow SHALL run nightly
against the latest versions of all vendor SDKs and CLIs the plugin
depends on. The workflow SHALL run translator snapshot tests against
each. Drift SHALL post a summary to a tracking issue; SHALL NOT fail
main CI; SHALL NOT block PR merges.

#### Scenario: New version of Codex SDK passes snapshots

- **GIVEN** the nightly drift job
- **WHEN** the latest `@openai/codex-sdk` is installed and translator
  tests run
- **THEN** if all snapshots match, the tracking issue is updated with
  "no drift"
- **AND** the job exits 0

#### Scenario: New version of Claude SDK breaks a snapshot

- **GIVEN** the nightly drift job
- **WHEN** the latest `@anthropic-ai/claude-agent-sdk` introduces a
  new event shape
- **THEN** the translator snapshot test fails
- **AND** the tracking issue is updated with the diff
- **AND** the job exits 0 (does not fail main CI)
- **AND** a label `drift:claude-sdk` is applied to the issue

### Requirement: Deprecation policy follows calendar dates

When a feature is deprecated (e.g., v1 mode), the plugin SHALL announce
a fixed calendar removal date. Removal SHALL NOT happen earlier than
the announced date. Removal SHALL be implemented as a separate
OpenSpec change after the date passes.

#### Scenario: v1 removal scheduled

- **GIVEN** v1 mode deprecated with removal date `2026-12-01`
- **WHEN** the maintainer prepares to remove v1
- **THEN** the maintainer creates a new OpenSpec change
  (`remove-v1-mode`)
- **AND** the change's earliest archive date is `2026-12-01`
- **AND** a deprecation notice has been emitted in plugin output for
  at least 30 days prior

### Requirement: v2.0.0 release tagged and announced

The plugin SHALL ship a `v2.0.0` tag on the main branch when this
proposal archives. The release SHALL include:

- a generated changelog from changesets accumulated since v1
- a docs/announcements/v2.0.0.md announcement post
- an updated README install command

#### Scenario: v2.0.0 tag exists post-archive

- **GIVEN** this proposal is archived
- **WHEN** the maintainer inspects `git tag`
- **THEN** `v2.0.0` is present
- **AND** points to a commit on main
- **AND** the commit is signed (if signing is configured)

#### Scenario: Announcement post visible

- **GIVEN** the v2.0.0 release
- **WHEN** a user reads the README
- **THEN** a banner or section announces v2.0.0
- **AND** links to `docs/announcements/v2.0.0.md` for details
- **AND** `docs/announcements/v2.0.0.md` lists breaking changes,
  migration guidance, and credits
