# Review Round 4 — Future Maintainer

**Reviewer lens**: a contributor joining the project six months from
now reads only the OpenSpec workspace. Can they figure out:
- the system's architecture
- which capability owns what
- where to add a new backend
- how decisions were made
- what's still open

**Method**: read the proposals in archive order. Treat them as if they
are the source of truth and the code is unfamiliar. Find places where
the spec leaves them stuck.

---

## Cross-cutting findings

### B-1: Capability index is incomplete

`docs/agent-cli-design.md` lists capabilities by name but doesn't:
- show which change introduced each
- link to the spec file
- distinguish ADDED from MODIFIED

A maintainer searching for "where is `feature-flags` defined" must
grep across all proposals.

**Fix**: amend `docs/agent-cli-design.md` with a capability matrix:

| Capability | Introduced in | Modified by |
|---|---|---|
| toolchain | modernize-toolchain | — |
| feature-flags | modernize-toolchain | add-app-server-transport-and-marketplace-split |
| ... | ... | ... |

### B-2: Cross-references between specs use prose, not links

When `transport-cli` references `feature-flags`, it does so in prose:
"as introduced in modernize-toolchain." A maintainer must navigate
file paths manually. Markdown links would help.

**Fix**: cross-reference using relative paths:
`[feature-flags](../../modernize-toolchain/specs/feature-flags/spec.md)`.
Apply at archive time when path stabilizes.

Actually more useful: at archive time, all specs move to
`openspec/specs/<capability>/spec.md`. Cross-references should target
those final paths. Note for archive process, not blocking.

### M-3: No top-level architecture overview

Reading 7 proposals to reconstruct the system is heavy. A new
maintainer needs:
- a 1-page "what this thing does"
- a layered diagram (backends → middleware → transports → ACP core)
- a "where to add X" guide

**Fix**: create `openspec/architecture.md` summarizing the layered
shape. Reference from `docs/agent-cli-design.md`. Each proposal
references this doc rather than re-explaining.

### M-4: Glossary missing

Terms used without definition: ACP, JSON-RPC framing, AcpSession,
backend, transport, translator, middleware, slash command, plugin
shell, marketplace. A new maintainer who knows generic ACP context
can guess; one without ACP context is lost.

**Fix**: `openspec/glossary.md` with definitions of project-specific
terms. Linked from `docs/agent-cli-design.md`.

### M-5: The dependency DAG is implicit

Round 1 noted this. Re-emphasized: a future maintainer needs to know
"what order do I read these in." Currently must read each proposal's
"Dependencies" section.

**Fix**: explicit DAG in `docs/agent-cli-design.md`.

---

## Per-proposal findings

### `modernize-toolchain`

#### M-1.1: design.md decision rationale lost on archive

After archive, `design.md` moves with the spec deltas. But the design
notes (D1-D7) are useful indefinitely — choices about pnpm vs npm,
tsgo vs tsc — these come up every time someone considers changing
tooling.

**Fix**: at archive time, decisions move to `docs/decisions/<topic>.md`
or an ADR-style record. Note for archive process.

#### M-1.2: feature-flags spec doesn't cross-reference v1 baseline doc

The new "v1 baseline" requirement (added in Round 1) references
`design.md`. After archive, design.md may move. The spec's reference
becomes stale.

**Fix**: at archive, update reference. Note for archive process.

### `add-testing-and-observability`

#### M-2.1: Many requirements; hard to find the canonical one

18 requirements across two specs. A maintainer asking "what's the
log format" may find conflicting hints in different places.

**Fix**: each spec's first requirement should be the canonical
"summary" — testing's summary: "vitest is the test runner";
observability's: "pino structured logs to stderr." Sub-requirements
fill detail. Already structured roughly this way; consider tightening.

#### M-2.2: Wire log scenario for the "real bug → fixture" workflow is
not in spec

Tasks T10.3 demands proving the workflow. Spec scenarios cover
mechanics. The end-to-end story (bug → wire log → fixture →
regression test) is in tasks but not codified as spec behavior.

**Fix**: defer to documentation rather than spec. The workflow is a
doc concern.

### `add-transport-abstraction-with-gemini`

#### M-3.1: "transport" vs "backend" boundary unclear in spec

A maintainer reads `acp-core` (which mentions transports), then
`transport-cli`, then `backend-gemini`. The roles seem to overlap
("backend declares transports"). Clear definition is in `design.md`
of an earlier proposal but not in any spec.

**Fix**: add a Requirement at the top of `acp-core` establishing the
layering: "transport handles wire mechanics; backend handles vendor
specifics." One scenario per layering boundary.

#### N-3.2: Conformance suite location

After archive, `lib/test-utils/conformance.mjs` lives in the code.
The spec says "the conformance test suite is applied via..." A
maintainer wonders which file.

**Fix**: ok as-is. Code has the file path; spec needn't duplicate.

### `add-codex-sdk-backend`

#### M-4.1: Translator pattern's reusable interface not specified

`add-codex-sdk-backend` introduces a translator. `add-claude-sdk-adapter`
introduces another. The translator interface is implicit (function
from event to ACP update or null). A future maintainer adding a
fourth translator (e.g., Bedrock) must reverse-engineer.

**Fix**: add a Requirement to `transport-sdk` capability explicitly
defining the translator contract:

> A translator SHALL be a pure function `(event) => SessionUpdate | null`.
> It SHALL NOT have side effects (no I/O, no mutation of input).
> Untranslatable events SHALL return null.
> Errors during translation SHALL throw, returning to the transport's
> error handler.

### `add-claude-sdk-adapter`

#### M-5.1: backend-claude spec heavy

20+ requirements in one spec. Reading is a lot. Subdivide?

**Fix**: leave for now; spec is correct, just dense. At archive,
consider splitting into `backend-claude` (core), `backend-claude-permissions`,
`backend-claude-translator`. Note for archive.

### `add-app-server-transport-and-marketplace-split`

#### M-6.1: Plugin shells are nearly identical; redundancy not noted

Each plugin shell (`plugins/{gemini,codex,claude}/`) has the same
structure. The spec doesn't capture this; a future maintainer
adding a fourth plugin won't know what's variable vs fixed.

**Fix**: add scenario "Plugin shells follow a template" — the
required files in each shell are enumerated; deviations are
documented per plugin.

#### M-6.2: marketplace.json schema dependency

If Anthropic changes marketplace.json schema, our spec doesn't track
which schema version we target.

**Fix**: spec should reference Anthropic's marketplace docs by URL
and note current schema version. A future maintainer can verify
compatibility.

### `add-middleware-and-release`

#### M-7.1: Middleware order not visualizable

The composition order (redaction → audit → ... → cache) is six
deep. Reading prose is okay but a diagram would land in 5 seconds.

**Fix**: add an ASCII diagram or Mermaid block in
`docs/middleware-architecture.md`. Note for documentation phase, not
spec.

#### M-7.2: /agent:* slash commands ownership

`/agent:cost` and `/agent:audit` are introduced. Which plugin
registers them? Round 2 raised this; need spec.

**Fix**: add Requirement "agent-shared slash commands have a single
registration point." Either a separate `agent-shared` plugin or
one of the three plugins owns them.

#### M-7.3: Drift CI tracking issue lifecycle

Spec says drift posts to a tracking issue. What happens when drift
resolves? Spec doesn't say.

**Fix**: drift CI SHALL close (or mark resolved on) the tracking
issue when no drift is observed for 7 consecutive days. Avoids
permanent open issues that fade into background.

---

## Verdict

7 proposals, 18 findings (5 blocking, 9 major, 4 notes).

**Blockers worth applying**:
1. Capability matrix in docs/agent-cli-design.md (B-1)
2. Cross-reference path standardization for archive (B-2 — note for
   archive process)
3. Architecture overview doc (M-3, promoted to blocker because future
   maintainers genuinely cannot navigate without it)
4. Glossary (M-4, similarly promoted)
5. Dependency DAG explicit in docs/agent-cli-design.md (M-5)
6. Translator interface contract (M-4.1)
7. /agent:* ownership (M-7.2)

Status: **Changes requested**, but most fixes are docs not spec.
