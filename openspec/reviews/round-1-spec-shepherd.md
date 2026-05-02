# Review Round 1 — Spec Shepherd

**Reviewer lens**: structural integrity, requirement clarity, scenario
completeness, OpenSpec format adherence.

**Method**: read each proposal's `proposal.md`, `tasks.md`, and every
`specs/<capability>/spec.md`. Validate format, check for missing
scenarios, find ambiguous SHALL statements, verify ## ADDED Requirements
sections are well-formed.

**Severity legend**:
- **B** — Blocking (must fix before approval)
- **M** — Major (should fix)
- **N** — Note (consider)

---

## Cross-cutting findings

### B-1: Validation contract not documented per change

None of the changes state which `openspec validate` command is expected
to pass. The implement-review-test-bench skill references
`openspec validate <change-id> --strict`, but proposals don't say
whether they're expected to pass strict mode.

**Fix**: add a "Validation" section to each `proposal.md` stating the
expected command. Default: `openspec validate <change-id> --strict`.

### B-2: Capability changes not declared as Added/Modified

OpenSpec convention: spec deltas headers are `## ADDED Requirements`,
`## MODIFIED Requirements`, `## REMOVED Requirements`. Proposals
introduce new capabilities throughout — all sections SHOULD use
`## ADDED Requirements`. Currently consistent, but
`add-app-server-transport-and-marketplace-split` modifies
`monorepo-shape` and `feature-flags` from earlier proposals (changes
the workspace globs and flips the default) — those should appear
under `## MODIFIED Requirements` in spec deltas, not as new
`## ADDED Requirements` against the same capability.

**Fix**: split spec deltas in `add-app-server-transport-and-marketplace-split`
to include `## MODIFIED Requirements` for the affected requirements
from `monorepo-shape` and `feature-flags`.

### M-3: Project plan doesn't list the dependency graph

`docs/agent-cli-design.md` lists 7 changes but doesn't show the
dependency ordering. A reader must read each `proposal.md`'s
"Dependencies" section to reconstruct the graph.

**Fix**: add a small DAG to `docs/agent-cli-design.md` showing
prerequisite relationships.

### N-4: No validation script provided

The repo has spec content but no scripts that exercise the OpenSpec
CLI. If `openspec` isn't installed locally, the proposals can't be
validated.

**Fix**: optional. Add `pnpm validate-specs` script or document the
install path for the OpenSpec CLI. Out of scope for this proposal set
but a maintainer note.

---

## Per-proposal findings

### `modernize-toolchain`

#### B-1.1: feature-flags spec covers v2 opt-in but not v1 baseline

The `feature-flags` spec asserts that `ACP_PLUGIN_VERSION=v2` opts into
v2 behavior, but the v1 baseline isn't enumerated. Without a captured
v1 baseline, "preserves v1 behavior" is unverifiable.

**Fix**: add a forward reference. Either (a) state that v1 baseline is
captured in the existing `gemini-companion.mjs` at the SHA recorded in
`design.md`, or (b) declare a follow-up `capture-v1-behavior` proposal
referenced as a dependency. Currently the proposal mentions this in
the "Dependencies" section but the spec doesn't reflect the contract.

#### M-1.2: Missing scenario for repeated installation

The "Fresh install" scenario covers a clean checkout. Doesn't cover:
existing `node_modules` from npm era is left behind. A user upgrading
from npm-based main might end up with mixed state.

**Fix**: add scenario "Migration from npm-installed working tree" to
`toolchain` spec. Expected behavior: instructions in the migration
section of README explicitly say to delete `node_modules` and
`package-lock.json` first.

#### M-1.3: tsgo fallback CI job not specified in spec

The proposal mentions "weekly CI cron job runs typecheck under stable
tsc as fallback validator" but the toolchain spec doesn't have a
scenario asserting this. Tasks include T2.6 but spec doesn't.

**Fix**: add scenario "Stable tsc fallback is verified weekly" to the
toolchain spec. (Wait — this scenario already exists. Verifying...)

Confirmed: the scenario IS already present. Withdrawing M-1.3.

#### N-1.4: design.md is rich; consider extracting some context to docs/

The `design.md` is excellent but contains content that will be
referenced repeatedly (D1-D7). Once archived, it becomes harder to
discover. Consider extracting D1, D3, D4 (tool choices) into a
`docs/toolchain.md` that lives alongside the working code.

**Fix**: defer to implementation. Note for the implementation phase.

---

### `add-testing-and-observability`

#### B-2.1: Wire log → fixture pipeline lacks scenario

Tasks include T7.5 (script that converts wire log to fixture) and
T10.3 (cycle proven on a real bug). The observability spec has a
"Wire log to fixture pipeline" scenario, but it doesn't assert that
the resulting fixture *works* with the test harness.

**Fix**: amend the scenario to also assert "the resulting fixture
passes `replayFixture()`". Already present — re-verifying...

Confirmed scenario does include `replayFixture()` assertion. Withdrawing.

#### M-2.2: Mutation score gate weakly specified

The testing spec says ≥70% mutation score. Doesn't say what action
is taken when the score drops below threshold. Tasks T3.4 says
"on failure, post a comment to a tracking issue" but the spec
doesn't enforce the workflow.

**Fix**: amend the "Mutation score gate" scenario to specify: when
score drops below threshold, the job opens a tracking issue (or
appends to one), but the gate does not block PR merges (since
mutation testing is nightly, not per-PR).

#### M-2.3: Wire log redaction list overlaps with logger redaction list

Both `lib/wire-log.mjs` and `lib/logger.mjs` redact sensitive fields.
The redaction lists are specified separately. Risk: lists drift apart;
a field redacted in logs might leak in wire log.

**Fix**: spec should reference a shared `lib/redaction-rules.mjs`
defining the canonical list, used by both wire log and logger. Add a
requirement in the observability spec.

#### M-2.4: OTel exit/teardown not specified

OTel SDK requires a graceful shutdown (`sdk.shutdown()`) to flush
spans on exit. If the plugin process exits abruptly, spans may be
lost. Spec doesn't address.

**Fix**: add scenario "OTel flushes spans on graceful exit" — on
SIGTERM / orderly shutdown, the plugin awaits `sdk.shutdown()` with
a 2-second timeout.

#### N-2.5: Property test count default is loosely specified

"runs at least 100 random cases by default" — fast-check default is
100, but if a contributor sets numRuns to 50 in vitest config the
spec is silently violated.

**Fix**: cite fast-check default explicitly in the requirement.

---

### `add-transport-abstraction-with-gemini`

#### B-3.1: Conformance suite contents not enumerated in spec

The acp-core spec says "the conformance test suite is applied" but
the suite's content is enumerated only in `tasks.md`. Spec readers
can't tell what conformance means.

**Fix**: add a Requirement "Conformance test suite covers session
lifecycle" to the acp-core spec, with sub-bullets enumerating the
covered behaviors (session/new returns sessionId, prompt round-trips,
cancel halts, close idempotent, permission requests work, health
transitions observable).

#### M-3.2: State schema versioning has no spec home

Tasks T6.* covers state schema versioning, but no `specs/<capability>/spec.md`
captures the requirement. State schema is a real cross-cutting concern.

**Fix**: either (a) add a `specs/state-schema/spec.md` with the
versioning requirements, or (b) fold into `feature-flags` as an
ADDED requirement covering forward/backward compatibility. (a) is
cleaner; do that.

#### M-3.3: CliTransport health thresholds documented but not configurability tested

The transport-cli spec says "thresholds SHALL be configurable per
backend." No scenario exercises the configurability.

**Fix**: add scenario "Custom thresholds applied" — `CliTransport`
configured with `healthCheckInterval: 5000` and `quietThreshold: 7000`
sees correct transition timing.

#### N-3.4: Backend-gemini spec doesn't assert non-regression of slash commands

The proposal mentions "user-visible behavior of /gemini:* commands
SHALL be unchanged." The spec has a "fixture replays succeed"
scenario but no scenario specifically asserting per-command behavior.

**Fix**: optional. Trust the integration tests; spec scenario for
fixture replay is sufficient. Note for implementation review.

---

### `add-codex-sdk-backend`

#### M-4.1: SdkTransport conformance scenario uses an undefined "identityTranslator"

The transport-sdk spec scenario says "identityTranslator" without
defining it. Likely meant: a translator that returns events
unchanged. Reader can guess but spec should be self-contained.

**Fix**: rename to `passthroughTranslator` and define in spec or in
a referenced doc.

#### M-4.2: Codex backend spec doesn't cover transport selection precedence

The spec covers default = SDK and CLI override, but doesn't cover the
case where a future user config selects transport explicitly via
plugin config. Precedence: explicit config > slash flag > default.

**Fix**: add scenario for transport selection precedence.

#### N-4.3: E2E budget cap monitoring not part of CI

Spec scenario "E2E budget cap reached" relies on the provider returning
an error when the cap is hit. But there's no scenario for monitoring
cap consumption — a user might want to know cap is at 80%.

**Fix**: defer to implementation (out of scope of this proposal).

---

### `add-claude-sdk-adapter`

#### B-5.1: Translator scenarios cover happy path but not malformed events

Translator scenarios cover correct events. Don't cover: SDK emits
malformed event (e.g., `{ type: 'assistant' }` without `content`).

**Fix**: add scenario "Translator handles malformed event" — returns
null, logs warning at error level (not debug), increments degraded-mode
counter.

#### M-5.2: Permission mode scenarios don't cover acceptEdits-with-non-edit-tool

Spec covers `acceptEdits` auto-approving `Edit`. Doesn't cover what
happens when the SDK requests a non-edit tool under `acceptEdits` mode.

**Fix**: add scenario "AcceptEdits prompts for non-edit tool" — under
`acceptEdits`, a `Bash` tool call still requests permission; the
backend doesn't conflate "edits" with "writes."

#### M-5.3: Degraded-mode counter threshold of 10/hour is arbitrary

"degraded-mode counter exceeds a threshold (10 events within an hour)"
— magic number, not justified. Could be 5, 100. The spec asserts the
threshold but doesn't tie it to anything.

**Fix**: add a brief rationale (this is a balance: too low = noisy
alerts, too high = real drift goes unnoticed). Make threshold
configurable; document default and tuning guidance.

---

### `add-app-server-transport-and-marketplace-split`

#### B-6.1: Spec doesn't capture monorepo-shape MODIFIED requirement

This proposal activates workspace globs that the original
`modernize-toolchain` spec deliberately left empty. This is a
modification of the existing spec, not an addition.

**Fix**: add `## MODIFIED Requirements` section to a new file
`specs/monorepo-shape/spec.md` showing the diff.

#### B-6.2: Spec doesn't capture feature-flags MODIFIED requirement

Same issue: this proposal flips the default of `ACP_PLUGIN_VERSION`
from `v1` to `v2`. That's a MODIFIED Requirement against the
existing capability.

**Fix**: add `specs/feature-flags/spec.md` with `## MODIFIED Requirements`
showing the new default.

#### M-6.3: Marketplace cache invalidation command not specified

The marketplace spec mentions a cache invalidation command but doesn't
provide it. Different Claude Code versions may use different commands.

**Fix**: cite the documented command (likely `claude plugin marketplace update`)
or note that the exact command lives in `docs/troubleshooting.md`
because it may evolve with Claude Code's CLI.

#### M-6.4: HttpTransport SSE reconnection budget not specified

Spec says "the transport attempts reconnection (up to a configurable
retry budget)" but doesn't specify default budget or backoff.

**Fix**: specify default — 3 reconnect attempts with exponential
backoff (1s, 2s, 4s). Make it configurable.

---

### `add-middleware-and-release`

#### B-7.1: Middleware order enforcement scenario missing the production warn-only mode

Spec covers development-mode throw and production-mode warn but
production scenario isn't written.

**Fix**: separate scenario for production mode. Confirmed already
present on second read. Withdrawing.

#### M-7.2: Cache eviction policy beyond TTL not specified

Cache spec covers TTL expiration but doesn't cover storage limits
(disk could fill). What if cache grows to 10 GB?

**Fix**: add a Requirement "Cache size is bounded" — default max
500 MB; LRU eviction; logged. This is an operational concern that
will hit users.

#### M-7.3: Audit log retention policy unclear under Windows

The retention scenario assumes Unix-style file age. Windows has
different timestamp semantics. Doesn't matter for Linux-first usage
but the rest of the proposal set claims "Windows untested but not
regressed."

**Fix**: defer; note that retention may need Windows-specific testing.

#### M-7.4: Cost middleware spec doesn't address concurrent sessions

If multiple sessions run concurrently, do they each have separate
metrics files (yes per spec) — but is the metrics file thread-safe?
The plugin runs single-threaded (Node), so no race within a process,
but multiple plugin processes (different terminal sessions) could
write to the same `metrics.json`.

**Fix**: clarify — `<session-id>` is unique per session, so files
don't collide. Add scenario asserting this. Two concurrent sessions
have separate metrics files.

#### M-7.5: Drift CI doesn't address Gemini SDK shape

Tasks T10.2 lists `@google/genai` in the matrix. Spec mentions it but
doesn't have a translator snapshot test (Gemini backend uses CLI
transport, not SDK; there's no Gemini translator). The drift matrix
should reflect this.

**Fix**: clarify drift matrix scope — Gemini drift checks CLI version
behavior (e.g., spawning `gemini --acp` and verifying handshake), not
SDK translator. Codex and Claude have translators.

#### M-7.6: Release SHALL be signed but signing setup not specified

Spec says "the commit is signed (if signing is configured)" — vague.
A 22-week project should commit to one path: signing configured (with
key management plan), or not.

**Fix**: pick one. Recommend: signing required for release tags;
documented in `docs/release-engineering.md`. Optional for ordinary
commits.

---

## Verdict

7 proposals, 26 findings (8 blocking, 14 major, 4 notes).

**Cross-cutting blockers**:
1. Add Validation section to each proposal.md (B-1)
2. Use MODIFIED Requirements where applicable in
   `add-app-server-transport-and-marketplace-split` (B-2, B-6.1, B-6.2)
3. Capture v1 baseline reference in feature-flags spec (B-1.1)
4. Conformance suite content in spec (B-3.1)
5. Translator malformed-event scenario in Claude (B-5.1)
6. Add state-schema spec home in transport abstraction proposal (M-3.2)

**Recommendation**: address blockers before further review. Major
findings can be addressed before Round 2 or in parallel.

Status: **Changes requested**.
