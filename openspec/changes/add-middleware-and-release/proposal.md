# Add Middleware and Release

## Why

The infrastructure is in place: three backends, three transports, three
plugins, marketplace published, v2 default. What remains is the
orthogonal cross-cutting layer — cost tracking, retry, fallback, audit,
cache — and the release engineering needed to maintain the codebase
beyond v2.0.0 (changesets, drift CI, public release).

This change introduces middleware as a composable layer wrapping
`AcpSession`, with each concern as a discrete well-specified module
that can be opted in or out. It also formalizes release engineering
so future changes ship reproducibly and upstream drift is tracked.

## What Changes

### Middleware layer

- **`lib/middleware/`** package with composable middlewares wrapping
  any `AcpSession`:
  - `redaction.mjs` — strips known secret patterns from prompts and
    audit/log payloads. Lands FIRST in the chain so all other
    middlewares see redacted content.
  - `audit.mjs` — append-only JSONL per session under
    `~/.acp-plugins/audit/<session-id>/audit.jsonl`. Operates on
    redacted content.
  - `cost.mjs` — accumulates token counts per session; persists to
    `~/.acp-plugins/sessions/<session-id>/metrics.json`; queryable
    via new `/agent:cost` slash command.
  - `retry.mjs` — wraps transport calls; exponential backoff for
    transient errors (rate-limit, network); configurable budget.
  - `fallback.mjs` — middleware-level fallback across model variants
    (e.g., `opus → sonnet → haiku`); configurable per backend.
  - `cache.mjs` — opt-in per command; hashes (prompt + context) →
    cached response; never caches commands that involve writes.
- **Composition order**: redaction → audit → cost → retry → fallback
  → cache. Documented as the canonical order; deviations require
  rationale.

### Release engineering

- **`changesets`** for versioning and changelog generation per
  workspace package.
- **`upstream-drift-*.yml`** CI jobs running nightly against latest
  versions of `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`,
  `@google/genai`, and `gemini`/`codex` CLIs. Drift posts to
  tracking issues; does not fail main CI.
- **`v2.0.0` public release** via changesets with full changelog.
- **Dependabot/Renovate** configured for non-pinned dependencies; pinned
  SDK versions excluded from automation.

## Impact

- **Affected specs**: introduces `middleware`, `release-engineering`.
- **Affected code**: new `lib/middleware/` package; companion code
  registers middleware chain at backend-init time. Existing slash
  commands gain `--no-cache`, `--no-retry` flags where applicable.
- **User impact**: middleware is opt-in via flags or config; default
  behavior preserves Stage 2 baseline.

## Dependencies

- `add-app-server-transport-and-marketplace-split` archived. v2 is the
  default. All three backends working.

## Risks and Mitigations

- **Middleware ordering bugs**: redaction MUST be first. Spec asserts
  order with a runtime check (`composeMiddleware([...])` validates
  redaction is at index 0; throws on misorder in dev mode).
- **Cache stale**: opt-in per command. Cache invalidation key includes
  prompt hash + context hash + git HEAD; stale commits change the key.
- **Audit log disk growth**: rotation policy documented; daily rotate;
  configurable retention (default 90 days).
- **Cost tracking accuracy**: token counts reported by SDK may differ
  from provider billing. Spec marks this as informational, not
  authoritative; cost API is the authority.
- **Changesets workflow noise**: every PR needing a changeset is
  enforced via CI; opt-out for docs-only PRs (e.g., changes under
  `docs/` only).

## Estimated Effort

3-3.5 weeks one engineer. Middleware: 2-2.5w (six modules including
audit rotation/retention, cost tracking with multi-backend usage
extraction, cache invalidation logic, and end-to-end chain test).
Release engineering: 1w (changesets, drift matrix consolidation, v2.0.0
tagging). Earlier estimates underplayed middleware complexity — see
Round 5 review for breakdown.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.

## Rollback

Middleware can be disabled per-instance via the
`ACP_DISABLE_MIDDLEWARE` env var, comma-separated middleware names.
For example, `ACP_DISABLE_MIDDLEWARE=cache,fallback` disables those
two without affecting redaction or audit.

This means a critical middleware bug discovered post-release does not
require a code revert; users mitigate via env var while a fix is
prepared. The release-engineering spec asserts this fallback path.

For unrecoverable issues, the proposal can be reverted as a
single-PR revert. Rollback removes the middleware files and restores
the previous direct backend invocation in each plugin's
`scripts/companion.mjs`.

Tested in `tests/e2e/middleware-disable.test.mjs` (added as part of
T8.5).
