# Add Claude SDK Adapter

## Why

Claude has no native ACP CLI; the Claude Agent SDK is the supported
substrate. With `SdkTransport` and translator pattern proven by Codex,
adding Claude is a focused exercise: write the Claude-specific
translator and backend declaration, plug into the existing infrastructure.

This is the highest-risk vertical of Stage 2 because Claude SDK event
shapes are richer than Codex (more tool use coverage, different
streaming model). It lands here, after testing infrastructure and the
SDK transport are warm, with the most leverage from existing tooling.

## What Changes

- **`@anthropic-ai/claude-agent-sdk`** added as exact-version dependency.
- **`lib/backends/claude/translator.mjs`** — translates Claude SDK
  message types (`assistant`, `tool_use`, `tool_result`, `result`,
  `system`) to ACP `session/update` shapes. ~500-1000 lines depending
  on fidelity.
- **`lib/backends/claude.mjs`** — declares Claude backend with `sdk`
  transport only (no native ACP CLI exists). `defaultTransport: 'sdk'`.
- **Degraded-mode fallback**: if Claude SDK emits events that don't
  translate cleanly (new event types, schema drift), the adapter falls
  back to text-only streaming with a logged warning. Better to ship
  reduced functionality than block the whole vertical.
- **E2E tests** against `claude-haiku-4-5` for cost.
- **Drift detection CI** running nightly against latest
  `@anthropic-ai/claude-agent-sdk`.

## Impact

- **Affected specs**: introduces `backend-claude`.
- **Affected code**: new files only; existing Codex and Gemini paths
  unchanged.
- **Plugin shells**: not yet (Claude plugin shell ships in
  `add-app-server-transport-and-marketplace-split`).

## Dependencies

- `add-codex-sdk-backend` archived (`SdkTransport` exists, conformance
  proven against second backend).
- Phase 5 spike (Claude SDK streaming abort behavior) completed.

## Risks and Mitigations

- **Highest-risk vertical**: lands with maximum infrastructure support
  (testing, observability, conformance suite all warm).
- **Event shape drift**: drift detection CI catches; degraded-mode
  fallback prevents Stage 2 blockage.
- **Tool call complexity**: Claude SDK exposes more tool types than
  Codex; translator must handle them or fall back gracefully.
- **Auth-file reading**: spike confirmed Claude Agent SDK reads
  `~/.claude/.credentials.json` when no explicit key. Tested in CI.

## Estimated Effort

3.5-4 weeks one engineer. The translator is the highest-risk vertical
in Stage 2 — Claude SDK emits more event types than the four covered
in spec (system, status, partial, etc.); each surprise costs 0.5-1 day.
Plus degraded-mode plumbing, in-process trust-boundary work (R3 B-5.1),
and persisting the degraded-mode counter add ~3-4 days beyond the bare
implementation. Earlier 3-week estimate did not budget translator
iteration on real SDK output.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
