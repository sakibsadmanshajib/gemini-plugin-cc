# Review Round 5 — Implementation Realist

> **Editor's note (2026-05-01):** This record references
> `openspec/project.md`, which OpenSpec 1.3 replaced with
> `openspec/config.yaml` (the `context:` section). The full operational
> content (DAG, effort tables, capability matrix, stage-gate checklist)
> was preserved at `docs/agent-cli-design.md`. Read action items below
> as targeting whichever of those two locations now holds the
> referenced content.

**Reviewer lens**: someone who has shipped multi-backend agent
infrastructure before. They look at the spec, they look at the
estimate, they look at the task list, and they ask: is this
actually going to ship in the time stated, or is the proposal
hiding work that surfaces in week 5?

**Method**: cross-reference each proposal's effort estimate against
its task count, scenario complexity, and external dependencies.
Look for invisible work — rebuild loops, infrastructure setup that
doesn't show up in tasks, "drift" that gets layered onto every
phase. Identify dependency-ordering bugs across proposals. Spot
items that look like 1-day work but are actually 1-week work in
disguise.

**Severity legend**:
- **B** — Blocking (must fix before approval)
- **M** — Major (should fix)
- **N** — Note

---

## Cross-cutting findings

### B-1: `add-middleware-and-release` 2.5-week estimate is incompatible with task scope

The proposal estimates 2.5 weeks (1.5 middleware + 1 release). The
tasks list has 14 task groups covering:
- 6 distinct middleware modules (compose, redaction, audit, cost,
  retry, fallback, cache)
- Persistence + rotation + retention for audit log
- Per-session metrics file with custom schema and a slash-command
  query interface (`/agent:cost`)
- Property tests for redaction
- Conformance test of wrapped MockBackend
- End-to-end test of full chain (rate-limit → retry → fallback →
  cost record)
- Changesets setup with PR template, CI gate, monorepo config
- Drift CI matrix consolidation across 5 cells
- v2.0.0 release tagging, announcement, migration notice
- Renovate/Dependabot config
- 4 docs files

A realistic estimate per task group:
- Compose + redaction: 2 days (redaction property test alone is half a day)
- Audit log with rotation/retention/slash command: 3 days (rotation
  edge cases eat time)
- Cost tracking with multi-backend usage extraction: 3 days
  (each backend reports usage differently; reconciliation isn't
  one-line)
- Retry + fallback + cache: 4 days (cache invalidation, security
  scoping, TTL sweep)
- Drift CI matrix: 2 days (matrix wiring + first failure debug
  cycle)
- Changesets + release: 2 days
- Docs: 1 day
- E2E + conformance: 2 days

That's ~19 working days = 4 weeks for one engineer, before any
debug surprise. With LLM assistance the optimistic floor is 3
weeks, not 1.5.

**Fix**: split this proposal. Option A (recommended): two
proposals — `add-middleware-layer` (2 weeks) and
`add-release-engineering` (1 week). Option B: keep as one but
state effort honestly at 3-3.5 weeks. The current 2.5-week framing
will slip and erode trust in subsequent estimates.

### B-2: `add-claude-sdk-adapter` 3 weeks doesn't budget translator iteration

3 weeks for the highest-risk vertical (Claude SDK). The translator
will need iteration when real SDK events surface edge cases. The
spec covers 4 message types (assistant, tool_use, tool_result,
result) but the SDK emits more (system messages, status, etc.).
Each surprise adds half a day to a week.

Plus: degraded-mode plumbing (R3 M-5.2 added persistence) is a
non-trivial feature on its own.

**Fix**: estimate to 3.5-4 weeks. Or: drop the persistence of the
degraded-mode counter (R3 M-5.2) — keep it in-memory; track via
audit log if needed.

### B-3: Stage gate work between phases not budgeted in any proposal

Each proposal has tasks but none budgets the stage gate work
itself: implementing MockBedrockTransport (per R3 conformance
requirement), reproducing a real bug from wire log, mutation score
debugging, cross-model code review of 2+ PRs, retro doc.

These are 2-3 days of work that lives between proposals 3 and 4.

**Fix**: add a stage-gate item either as a 0.5-week proposal of
its own (`stage-1-gate`) or as a final task block in
`add-transport-abstraction-with-gemini`. Currently invisible.

### M-4: Spec count vs effort estimate mismatch on testing-and-observability

`add-testing-and-observability` is 3 weeks (2 with LLM assistance).
Two specs with 13 requirements between them, ~30 scenarios. Plus:
- Vitest setup (custom matchers? snapshot config?)
- fast-check integration with vitest
- Stryker config (mutation testing setup is fiddly)
- ACP test harness (`in-memory-transport`, `fake-acp-backend`,
  `fixture-replayer`, fake CLI binaries)
- Pino + redaction config
- Wire log implementation with size limit (R2 M-5)
- OTel lazy-load
- Cold-start benchmark
- Property test infrastructure

Three weeks is plausible if everything works first try. Two weeks
with LLM is optimistic.

**Fix**: keep 3-week estimate, drop the "2 with LLM" optimistic
floor. LLM helps with code generation, not with debugging
fast-check edge cases or stryker config.

### M-5: Inter-proposal dependency: testing/observability blocks transport work

`add-testing-and-observability` is proposal 2; `add-transport-abstraction-with-gemini`
is proposal 3. The transport proposal's tasks rely on the test
harness from proposal 2. If proposal 2 slips, proposal 3 starts
late.

Two practical options:
- Hard sequencing: proposal 2 must complete fully before 3 starts.
  Estimate-honest, slow.
- Parallel: proposal 3 starts when proposal 2's test harness work
  (T1-T3 of testing tasks) is done; proposal 2's observability
  work continues in parallel.

The plan implies sequencing but doesn't say. If parallel, the
scope of "testing-only blocking" needs to be explicit.

**Fix**: project.md adds a note: "proposals 2 and 3 may overlap
once testing harness primitives ship." Or commit to sequencing.

### M-6: Estimates assume single engineer; pivot policy assumes one too

Each proposal estimates "X weeks one engineer." If the project
has reviewers commenting on PRs, the throughput is the engineer's
solo speed minus context-switch cost. Realistic: 80% of solo speed.

**Fix**: not blocking; note that estimates are nominal solo speed.
Real throughput accounts for review cycles.

---

## Per-proposal findings

### `modernize-toolchain`

#### M-1.1: 1.5-week estimate vs 15+ task items

Tasks list ranges from "edit gitignore" (5 min) to "configure
husky pre-commit hooks across the workspace" (4 hours). 15 tasks
at average 2-3 hours each is 4-5 days. 1.5 weeks (7.5 days) buffers
this realistically.

But: the proposal is the first one. Toolchain choices made here
will need iteration when subsequent proposals expose mismatches
(e.g., Stryker doesn't like JSDoc-typed code). Iteration time is
not in the estimate.

**Fix**: keep 1.5 weeks but add: "buffer of 2-3 days for iteration
on tooling choices when later proposals expose issues." Track that
buffer separately.

#### N-1.2: Renovate setup deferred to proposal 7 — fine

Some toolchain projects do dep management in toolchain phase.
This plan defers to proposal 7. Reasonable given proposal 7 owns
the release engineering capability.

### `add-testing-and-observability`

#### M-2.1: Mutation testing setup time underestimated

Stryker configuration for JSDoc-typed mjs code in pnpm workspace
is non-trivial. First-time setup with debugging is 2-3 days.
Tasks list includes Stryker config but the time isn't isolated.

**Fix**: at minimum, document Stryker setup as a dedicated 0.5-day
task block. Don't bury in T-something.

#### M-2.2: Fixture replayer scope creep risk

`fixture-replayer` is an in-memory transport that replays JSONL
fixtures. Spec is straightforward. But edge cases (out-of-order
events, partial replays, fixture-vs-spec drift detection) tend to
expand scope.

**Fix**: scope-cap the fixture replayer in tasks: "Implement
exact-replay only. Fuzzy-replay (diff tolerance) is out of scope
for this proposal."

### `add-transport-abstraction-with-gemini`

#### B-3.1: 2.5 weeks for transport abstraction + Gemini end-to-end is tight

Tasks include:
- ACP core (JSON-RPC framing with edge cases, AcpSession contract,
  client implementation, conformance suite)
- CliTransport (subprocess lifecycle, env filtering per R2 B-1,
  PATH resolution per R3 B-3.1, SIGTERM grace, heartbeat with
  warmup pause per R2 M-3.2, backpressure per R2 M-3.3)
- Gemini backend (config, slash command non-regression, fixture
  replays match v1)
- State schema versioning (per R1 M-3.2)
- MockBackend (per R1 M-3.2)
- v1/v2 coexistence
- All this with ≥80% test coverage and conformance suite

This is a 3-3.5 week scope honestly. The "1.5 weeks with LLM"
floor is quite optimistic.

**Fix**: revise to 3 weeks unbuffered, 3.5 weeks buffered. Drop
the "1.5 with LLM" line; that floor is unrealistic for the
amount of integration testing required.

#### M-3.2: Conformance suite reuse across transports is the leverage point

A well-designed conformance suite is the difference between the
2.5 and 3.5 week estimates. If the suite is incomplete, every
later transport (SDK, HTTP) re-discovers gaps. Investing in
suite quality here saves time in proposals 4-6.

**Fix**: not a spec change; an implementation note. The conformance
suite SHALL be the unit of conformance, not "passes the demo."

### `add-codex-sdk-backend`

#### M-4.1: 2 weeks — Codex SDK pinning + translator + E2E

Tasks list includes:
- Spike for Codex SDK auth behavior (3 days, but spec says spikes
  are in proposal 0 / phase 5 spikes)
- SdkTransport implementation
- Translator
- E2E with budget cap

If spikes are pre-completed, 2 weeks is plausible. If spikes happen
during this proposal, it's 2.5-3 weeks.

**Fix**: state explicitly: "Phase 5 spikes complete before this
proposal starts. Spikes blocking this proposal are: SDK auth
behavior, abort signal honoring, and translator event surface."

#### M-4.2: E2E budget cap monitoring

Per R3 M-4.2, client-side budget cap is required. That's a small
addition (~1 day) but fits in the 2 weeks if accounted for.

**Fix**: tasks list adds explicit budget-cap implementation item.

### `add-claude-sdk-adapter`

(Covered in B-2 above.)

### `add-app-server-transport-and-marketplace-split`

#### M-6.1: 3 weeks for HttpTransport + plugin shells + marketplace

This proposal's tasks include:
- HttpTransport (App Server lifecycle, port allocation, SSE
  parsing, reconnection with budget per R2 B-2, in-flight prompt
  failure, server crash recovery, loopback enforcement per R3
  B-6.1, conformance)
- Plugin shells in 3 directories with shared lib
- Marketplace.json + install command docs
- v1 deprecation runway logic
- Rollback procedure dry-run with documentation

3 weeks is realistic but the rollback drill is a wildcard. If the
drill surfaces issues (which is its job), iteration adds time.

**Fix**: estimate stays 3 weeks; add explicit task "rollback drill
issues addressed before flip merge" with budget of 2-3 days.

#### M-6.2: Plugin shells are nearly identical — implementation reuse

Each plugin shell is ~3-4 files. Three plugins share most of the
structure. Tasks list creates 3 sets in parallel. Real practice:
write one, generalize, copy.

**Fix**: tasks list explicitly does this: T1.1 builds gemini shell;
T1.2 extracts common into `@artagon/acp-plugin-lib`; T1.3 creates
codex shell using lib; T1.4 same for claude. This pattern is more
honest about effort.

### `add-middleware-and-release`

(Covered in B-1 above.)

#### M-7.1: Drift CI matrix consolidation timing

Tasks T10 consolidates earlier drift jobs. But earlier proposals
introduced drift CI per backend. If those landed as nightly cron
jobs, removing them in favor of a matrix in proposal 7 means up
to 4 months of drift signal for backends. That's fine; just
worth noting.

**Fix**: not blocking. Document in release-engineering spec.

---

## Verdict

**Status**: changes requested. 3 blocking, 7 major, 1 note.

**Blockers worth applying**:
1. Re-estimate `add-middleware-and-release` to 3-3.5 weeks or split
   it into two proposals (B-1)
2. Re-estimate `add-claude-sdk-adapter` to 3.5-4 weeks (B-2)
3. Stage-gate work explicitly budgeted (B-3)

The plan-level totals were 22-25 weeks buffered (per the
conversation summary). With the realistic re-estimates:
- Modernize: 1.5-2w
- Testing/obs: 3w
- Transport+Gemini: 3-3.5w
- Codex SDK: 2-2.5w
- Stage gate: 0.5w (was invisible)
- Claude SDK: 3.5-4w
- App-server+marketplace: 3w
- Middleware+release: 3-3.5w

Sum: 19.5-22w unbuffered. With 20% risk loading: 23-26w buffered.

This roughly matches the prior plan's 22-25w buffered estimate.
The realism check confirms the plan-level number; surfaces that
some proposals were over-promising while others were honestly
estimated. Net: no plan-level change needed; per-proposal
estimates need adjustment.

Status: **Approved with revisions** — apply per-proposal estimate
fixes, then ready for `ospx implement` of proposal 1.
