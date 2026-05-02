# Tasks: add-middleware-and-release

## 1. Middleware composition primitive

- [ ] T1.1 — Create `lib/src/middleware/compose.mjs` with
  `composeMiddleware(middlewares)` returning a single
  `AcpSession`-wrapping function. Order is left-to-right (first
  middleware is outermost).
- [ ] T1.2 — Validate composition: redaction MUST appear at index 0;
  throw `MiddlewareOrderError` in development mode if violated;
  warn-only in production
- [ ] T1.3 — Pass-through identity middleware as smoke test
- [ ] T1.4 — Document composition contract in
  `docs/middleware-architecture.md`

## 2. Redaction (FIRST in chain)

- [ ] T2.1 — Create `lib/src/middleware/redaction.mjs`
- [ ] T2.2 — Default redaction patterns:
  - API key shapes (`sk-...`, `ant-...`, `AIza...`, OpenAI/Anthropic/
    Google patterns)
  - Bearer tokens in payloads
  - PEM blocks
  - URLs with embedded credentials (`https://user:pass@host/`)
- [ ] T2.3 — Configurable additional patterns via config file
  `~/.acp-plugins/redaction.json`
- [ ] T2.4 — Apply to: outbound prompts, captured tool outputs, audit
  log inputs, observability log payloads
- [ ] T2.5 — Property test: random text with embedded secrets →
  redaction → no original secret remains
- [ ] T2.6 — Document redaction patterns in `docs/redaction.md`

## 3. Audit log

- [ ] T3.1 — Create `lib/src/middleware/audit.mjs`
- [ ] T3.2 — Append-only JSONL: `~/.acp-plugins/audit/<session-id>/audit.jsonl`
- [ ] T3.3 — Audit record shape: `{ t, sessionId, kind, payload }` where
  `payload` is already-redacted content from upstream redaction middleware
- [ ] T3.4 — Records: prompts, tool calls, tool results, completions,
  errors, health transitions
- [ ] T3.5 — Daily rotation: yesterday's file gzipped to `audit.jsonl.<date>.gz`
- [ ] T3.6 — Retention: configurable, default 90 days; older files
  removed by background cleanup script
- [ ] T3.7 — Slash command `/agent:audit <session-id>` reads and
  pretty-prints audit log
- [ ] T3.8 — Test: redaction precedes audit (audit log contains no
  unredacted secrets in property test)

## 4. Cost tracking

- [ ] T4.1 — Create `lib/src/middleware/cost.mjs`
- [ ] T4.2 — Per-session metrics file:
  `~/.acp-plugins/sessions/<session-id>/metrics.json`
- [ ] T4.3 — Metrics shape:
  ```
  {
    sessionId, backend, model,
    tokensIn, tokensOut, cachedTokens,
    estimatedUsd,
    startedAt, endedAt,
    counts: { prompts, toolCalls, errors }
  }
  ```
- [ ] T4.4 — Token counts pulled from backend-specific result events
  (Codex `usage`, Claude `result`, Gemini `usageMetadata`)
- [ ] T4.5 — `/agent:cost` slash command across all three plugins:
  - no args → list recent sessions with totals
  - `<session-id>` → details for that session
  - `--since <date>` → aggregate over time range
- [ ] T4.6 — Document non-authoritative nature in `docs/cost-tracking.md`
  (provider billing is the authority)
- [ ] T4.7 — Test: token deltas accumulate correctly across multiple
  prompts in a session

## 5. Retry middleware

- [ ] T5.1 — Create `lib/src/middleware/retry.mjs`
- [ ] T5.2 — Retry on transient errors only: `kind: 'rate-limited'`,
  `kind: 'network'`. NOT on `auth-required`, `internal`, `aborted`.
- [ ] T5.3 — Exponential backoff: 1s, 2s, 4s, 8s, 16s; max 3 retries;
  configurable
- [ ] T5.4 — Surface retry attempts in observability spans (add event
  `retry.attempt` with attempt number and reason)
- [ ] T5.5 — Test: simulated rate-limit error → retry → success
- [ ] T5.6 — Test: simulated permanent auth error → no retry → fail fast
- [ ] T5.7 — `--no-retry` flag on slash commands disables for that call

## 6. Fallback middleware

- [ ] T6.1 — Create `lib/src/middleware/fallback.mjs`
- [ ] T6.2 — Fallback chain configured per backend; example:
  `claudeBackend.fallback = ['opus', 'sonnet', 'haiku']`
- [ ] T6.3 — Trigger conditions: same as retry's "permanent" errors
  (so retry exhausts → fallback kicks in), plus model-overload
  responses
- [ ] T6.4 — Slash command `--model <alias>` overrides fallback start
- [ ] T6.5 — `--no-fallback` flag disables for that call
- [ ] T6.6 — Test: opus over-capacity → fallback to sonnet → success;
  cost middleware records both attempts separately

## 7. Cache middleware

- [ ] T7.1 — Create `lib/src/middleware/cache.mjs`
- [ ] T7.2 — Cache key: SHA256(prompt + serialized-context + git-HEAD)
- [ ] T7.3 — Cache store: `~/.acp-plugins/cache/<key>.json`
- [ ] T7.4 — Opt-in per command via `--cache` flag; default off
- [ ] T7.5 — Never cache commands with side effects (`/<backend>:rescue`,
  any tool call that writes); allowlist of cacheable commands:
  `review`, `adversarial-review`
- [ ] T7.6 — Cache expiration: configurable TTL, default 7 days
- [ ] T7.7 — Cache invalidation: `git checkout` to a different HEAD
  produces different keys; explicit `--no-cache` bypasses
- [ ] T7.8 — Document cache semantics and security in `docs/cache.md`

## 8. Middleware integration

- [ ] T8.1 — Update each plugin's `companion.mjs` to compose middlewares
  around the backend's `AcpSession`
- [ ] T8.2 — Composition default order: `[redaction, audit, cost, retry,
  fallback, cache]`
- [ ] T8.3 — Slash commands honor `--no-retry`, `--no-fallback`,
  `--cache`/`--no-cache`
- [ ] T8.4 — Conformance: middleware-wrapped `MockBackend` passes
  conformance suite (verifies wrapping is transparent)
- [ ] T8.5 — End-to-end test: rate-limit → retry → fallback → cost
  records both attempts → audit log captures redacted payloads

## 9. Changesets setup

- [ ] T9.1 — Install `@changesets/cli` and `@changesets/changelog-github`
- [ ] T9.2 — Run `pnpm changeset init`
- [ ] T9.3 — Configure for monorepo: each workspace package versions
  independently
- [ ] T9.4 — Add `pnpm changeset` to PR template; CI check that
  PRs touching code include a changeset (skippable for docs-only)
- [ ] T9.5 — Document changeset workflow in `docs/contributing.md`

## 10. Drift CI consolidation

- [ ] T10.1 — Consolidate `upstream-drift-*.yml` jobs introduced in
  earlier proposals into a single `upstream-drift.yml` matrix job
- [ ] T10.2 — Matrix: `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`,
  `@google/genai`, `gemini` CLI, `codex` CLI
- [ ] T10.3 — Each cell runs that backend's translator snapshot tests
  against latest version
- [ ] T10.4 — Drift posts a single consolidated comment to a tracking
  issue; updates daily; no main CI failures
- [ ] T10.5 — Auto-create issues for new drift; close resolved drift

## 11. v2.0.0 release

- [ ] T11.1 — Generate full changelog from changesets
- [ ] T11.2 — Tag `v2.0.0` on main
- [ ] T11.3 — Publish marketplace plugins (if applicable; Claude Code
  marketplaces source from git directly so this may be a no-op)
- [ ] T11.4 — Announcement post draft for `docs/announcements/v2.0.0.md`
- [ ] T11.5 — Migration notice for v1 users (already in
  `docs/v1-deprecation.md`); update with v2.0.0 link

## 12. Dependabot / Renovate

- [ ] T12.1 — Configure renovate.json: weekly updates for non-pinned
  deps, manual review for pinned SDKs
- [ ] T12.2 — Group toolchain updates (Biome, vitest, etc.) into single PRs
- [ ] T12.3 — Pinned SDK exclusions documented in `renovate.json` with
  rationale comments

## 13. Documentation

- [ ] T13.1 — `docs/middleware-architecture.md` — composition order,
  contracts, when to add a new middleware
- [ ] T13.2 — `docs/redaction.md`, `docs/cost-tracking.md`,
  `docs/cache.md` — per-middleware deep dive
- [ ] T13.3 — `docs/release-engineering.md` — changesets workflow,
  drift policy, deprecation policy
- [ ] T13.4 — Architecture diagram updated to show middleware layer

## 14. Verification

- [ ] T14.1 — All conformance tests pass with default middleware chain
- [ ] T14.2 — Mutation score on `lib/src/middleware/` ≥ 70%
- [ ] T14.3 — Property test for redaction passes (no secrets leak
  through any path)
- [ ] T14.4 — End-to-end test of full middleware chain succeeds
- [ ] T14.5 — At least 3 PRs reviewed via `/codex:adversarial-review`
- [ ] T14.6 — v2.0.0 release published

## Acceptance

- [ ] All tasks complete
- [ ] CI green including drift matrix
- [ ] Middleware chain in default order is the active configuration
- [ ] No regressions in any backend's conformance
- [ ] `/agent:cost` and `/agent:audit` slash commands functional
- [ ] v2.0.0 tagged and announced
