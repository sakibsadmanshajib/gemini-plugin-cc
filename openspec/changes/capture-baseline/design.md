# Design: capture-baseline

This change is descriptive, not prescriptive. There is no architecture to design — the implementation already exists at commit `f8f773c`. This document is intentionally brief and exists only to record the small number of authoring decisions that aren't obvious from `proposal.md` and `tasks.md`.

## D1. Snapshot at `f8f773c`, not `HEAD`

**Decision:** the spec quotes commit SHA `f8f773c` (`fix(openspec): rewrite stale project.md mentions in review records`) on `main` as the baseline, not whatever `HEAD` points at when the change archives.

**Rationale:** if `main` advances during this change's authoring, the spec stays anchored to a single reproducible point. Readers can `git checkout f8f773c -- plugins/gemini/scripts/` to verify any requirement against live source. A floating `HEAD` baseline is unverifiable.

**Trade-off:** if a behavior change lands on `main` between snapshot and archive, the spec is stale-by-construction. Mitigation: tasks include a final pre-archive step that re-checks `main..f8f773c` for changes to `plugins/gemini/scripts/` and `plugins/gemini/hooks/`. If there are any, re-snap to the new SHA and re-validate.

## D2. Capture as-is, not idealized

**Decision:** the spec records what the code does today, including warts. Examples:

- The stop-review-gate hook spawns `gemini -p` directly, bypassing the broker. This is inconsistent with the broker-mediated everything-else, but it is what `stop-review-gate-hook.mjs:64` does.
- ACP `clientInfo.name` is the literal string `"gemini"`, not `"gemini-plugin-cc"`. This is a known regression risk noted in `plugin-info.mjs:20`, but it is what the code emits today.

**Rationale:** the spec is the diff base for v2. Redesigns (e.g., routing the stop-review-gate through the broker) happen in named v2 changes that cite `gemini-plugin-baseline` and author `## MODIFIED Requirements`. If we cleaned up while capturing, the diff base would be fictional and v2 changes couldn't show real deltas.

**Alternative considered:** capture the _intended_ v1 behavior and treat current divergences as bugs to fix. Rejected because (a) "intended" is not in the source — it's in someone's head; and (b) the validator-line-1 rule means even "fix-as-we-go" requires careful re-validation, multiplying scope.

## D3. One requirement per surface area, not one per source file

**Decision:** organize spec requirements by user-visible contract (CLI surface, `--json` shape, hook contract, state layout, host detection, env vars, ACP wire identity, spawn contract) rather than by source file (`acp-broker.mjs`, `gemini-companion.mjs`, …).

**Rationale:** consumers of `gemini-plugin-baseline` (the modernize-toolchain feature-flags spec, future v2 spec deltas) reason about contracts, not file boundaries. The transport refactor in `add-transport-abstraction-with-gemini` will move code across files while preserving contracts; if requirements were file-organized, every refactor would invalidate the requirement-to-file mapping.

**Trade-off:** scenarios then need explicit file:line citations to remain verifiable. Tasks include this requirement explicitly (T-spec-author).

## Out of scope

- Anything that requires running code (smoke tests, fixture replay, etc.). Belongs in `add-testing-and-observability`.
- Decisions about _future_ shape of v2. Belongs in the v2 changes that consume this baseline.
