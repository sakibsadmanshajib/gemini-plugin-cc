# acp-plugins-cc — OpenSpec Project

This OpenSpec workspace tracks the modernization of `gemini-plugin-cc`
into `acp-plugins-cc` — a multi-backend ACP plugin suite for Claude
Code.

For orientation:
- [`openspec/architecture.md`](../openspec/architecture.md) — layered
  system overview
- [`openspec/glossary.md`](../openspec/glossary.md) — definitions of
  project-specific terms

> **Note:** This file was previously `openspec/project.md`. OpenSpec 1.3
> replaced that role with `openspec/config.yaml` (the `context:` section
> is loaded into every planning request). The operational content here
> — effort tables, stage-gate checklist, full DAG, capability matrix —
> is preserved as a project-management artifact rather than as
> always-loaded planning context.

## Structure

- `openspec/changes/<change-id>/` — pending change proposals
- `openspec/specs/<capability>/spec.md` — archived canonical specs
  (post-archive)
- `openspec/reviews/round-*-<persona>.md` — review records, one per
  persona per round

## Change set

**Stage 1 — Foundation modernization** (13-14 weeks buffered)

| ID | Phase | Effort |
|---|---|---|
| `modernize-toolchain` | 1 | 1.5 weeks |
| `add-testing-and-observability` | 2-3 | 3 weeks |
| `add-transport-abstraction-with-gemini` | 4 | 3 weeks |

**Stage gate** — go/no-go after the third change archives. Budgeted at
0.5-1 week (was previously invisible per Round 5 review). Includes:
- Implement `MockBedrockTransport` against existing `AcpSession`
  interface; pass conformance suite (architectural-fitness check)
- Reproduce one real or synthetic bug via wire-log → fixture →
  regression test cycle
- Mutation-score gate: ≥70% on `lib/acp/`, `lib/transport/`
- Cross-model code review (Codex or Gemini) on at least 2 PRs per
  archived proposal in Stage 1
- Retro doc: `docs/stage-1-retro.md`
- Pivot review: confirm Stage 2 scope still desired, given what was
  learned in Stage 1

**Stage 2 — Multi-backend expansion** (12-14 weeks buffered)

| ID | Phase | Effort |
|---|---|---|
| `add-codex-sdk-backend` | 6 | 2-2.5 weeks |
| `add-claude-sdk-adapter` | 7 | 3.5-4 weeks |
| `add-app-server-transport-and-marketplace-split` | 8-9 | 3 weeks |
| `add-middleware-and-release` | 10-11 | 3-3.5 weeks |

**Headline plan total**: 25-29 weeks buffered. Earlier 22-25w estimate
held the right shape; per-proposal estimates were optimistic in the
middleware and Claude-SDK proposals (Round 5 finding). Net plan-level
delta: ~3 weeks to honestly account for previously hidden work.

## Dependency DAG

```
modernize-toolchain
        │
        ▼
add-testing-and-observability
        │
        ▼
add-transport-abstraction-with-gemini   ◄── stage gate
        │
        ▼
add-codex-sdk-backend
        │
        ▼
add-claude-sdk-adapter
        │
        ▼
add-app-server-transport-and-marketplace-split
        │
        ▼
add-middleware-and-release
```

Each arrow is a hard prerequisite: the upstream change MUST archive
before the downstream change starts implementation.

## Capability matrix

| Capability | Introduced in | Modified by |
|---|---|---|
| `toolchain` | modernize-toolchain | — |
| `monorepo-shape` | modernize-toolchain | add-app-server-transport-and-marketplace-split |
| `feature-flags` | modernize-toolchain | add-app-server-transport-and-marketplace-split |
| `testing` | add-testing-and-observability | — |
| `observability` | add-testing-and-observability | — |
| `acp-core` | add-transport-abstraction-with-gemini | — |
| `transport-cli` | add-transport-abstraction-with-gemini | — |
| `backend-gemini` | add-transport-abstraction-with-gemini | — |
| `state-schema` | add-transport-abstraction-with-gemini | — |
| `transport-sdk` | add-codex-sdk-backend | — |
| `backend-codex` | add-codex-sdk-backend | add-app-server-transport-and-marketplace-split |
| `backend-claude` | add-claude-sdk-adapter | — |
| `transport-http` | add-app-server-transport-and-marketplace-split | — |
| `plugin-shells` | add-app-server-transport-and-marketplace-split | — |
| `marketplace` | add-app-server-transport-and-marketplace-split | — |
| `middleware` | add-middleware-and-release | — |
| `release-engineering` | add-middleware-and-release | — |

## Conventions

Every change MUST include:
- `proposal.md` — Why, What changes, Impact, Validation, Rollback
- `tasks.md` — checklist with task IDs (T1.1, T1.2, ...)
- `specs/<capability>/spec.md` — at least one spec delta
- `design.md` — only when technical decisions need rationale beyond
  spec

Each Requirement uses a single `### Requirement:` header followed by
SHALL/MUST language and one or more `#### Scenario:` blocks (Gherkin
GIVEN/WHEN/THEN). When modifying a prior change's capability, the spec
delta uses `## MODIFIED Requirements`. New capabilities use
`## ADDED Requirements`.

Validation: `openspec validate <change-id> --strict`

Archive moves spec deltas from `openspec/changes/<id>/specs/<cap>/spec.md`
to `openspec/specs/<cap>/spec.md` (merging into the canonical spec).
Cross-references between specs SHALL use relative paths to the final
archived locations.

## Reviews

Five rounds of adversarial review across all proposals. Records under
`openspec/reviews/`:

1. `round-1-spec-shepherd.md` — structural integrity, requirement
   clarity, scenario completeness
2. `round-2-adversarial-engineer.md` — race conditions, error paths,
   technical attacks
3. `round-3-security-operations.md` — secrets, auth, rollback, blast
   radius
4. `round-4-future-maintainer.md` — discoverability, consistency,
   readability for newcomers
5. `round-5-implementation-realist.md` — effort accuracy, dependency
   ordering, parallelizability, testability

Each round produced findings; blocking findings were applied as spec
revisions before the next round.
