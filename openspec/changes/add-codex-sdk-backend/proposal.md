# Add Codex SDK Backend

## Why

`add-transport-abstraction-with-gemini` proved the abstraction against
one CLI-based backend. To validate the abstraction before committing to
the full Stage 2 scope, this change adds a second backend on a different
transport: Codex via the `@openai/codex-sdk` package, in-process. This
exercises the SDK-bridge translation pattern without yet adding the
highest-risk Claude adapter.

If the abstraction creaks here, we find out before committing to the
Claude SDK adapter, which is a longer and more invasive piece of work.

## What Changes

- **`lib/transport/sdk.mjs`** — `SdkTransport` base, generic enough to
  serve both Codex SDK and (future) Claude SDK adapters. Encapsulates:
  - in-process SDK lifecycle (instantiate, stream, abort)
  - SDK-event-to-ACP-update translation via injected `translator`
  - abort signal propagation
  - error normalization
- **`lib/backends/codex.mjs`** — Codex backend with `sdk` and `cli`
  transports. SDK transport uses `@openai/codex-sdk`; CLI transport
  uses `codex` CLI in ACP mode (when available).
- **`lib/backends/codex/translator.mjs`** — translates Codex SDK events
  to ACP `session/update` shapes. Roughly 200-400 lines depending on
  fidelity goals.
- **E2E tests** against real Codex with provider-side budget cap on the
  API key. Cheap models only (`spark`, `mini`).
- **Drift detection CI** running nightly against latest `@openai/codex-sdk`,
  reporting changes to event shapes.

## Impact

- **Affected specs**: introduces `transport-sdk`, `backend-codex`.
- **Affected code**: new files only; existing Gemini path unchanged.
- **Plugin shells**: not touched yet (Codex plugin shell ships in
  `add-app-server-transport-and-marketplace-split`).

## Dependencies

- `add-transport-abstraction-with-gemini` archived.
- Phase 5 spike (Codex SDK auth-file behavior) completed.

## Risks and Mitigations

- **Codex SDK API changes**: pinned exact version. Drift CI catches
  breaks. Translator includes version assertion at startup.
- **Auth-file reading**: spike confirmed `new Codex()` with no args
  reads `~/.codex/auth.json`. Tested in CI with a fixture auth file.
- **Streaming abort**: SDK abort signals tested for promptness via
  integration test (cancel mid-stream, verify callbacks stop within
  500ms).

## Estimated Effort

2 weeks one engineer.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
