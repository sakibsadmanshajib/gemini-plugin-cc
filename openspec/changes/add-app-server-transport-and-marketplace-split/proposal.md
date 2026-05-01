# Add App Server Transport and Marketplace Split

## Why

Two remaining gaps before public release:

1. **Codex App Server transport** — for users who want to share one
   long-running Codex server across many sessions, or who need the
   richer feature surface that the App Server exposes (sandboxing,
   approval flow, full Codex configuration).
2. **Marketplace split** — currently the repo ships one Claude Code
   plugin (`/gemini:*`). To expose Claude and Codex as first-class
   plugins, the repo needs to publish three separate plugins via the
   marketplace, sharing the `lib/` infrastructure via pnpm workspaces.

This change introduces the workspace split and `HttpTransport`, then
publishes the marketplace.

## What Changes

- **pnpm workspaces activated**: `pnpm-workspace.yaml` declares
  `lib` and `plugins/*` as workspace packages.
- **`lib/` becomes its own workspace package**: `@artagon/acp-plugin-lib`.
  All shared code lives here.
- **`plugins/{gemini,codex,claude}/`**: three Claude Code plugin shells.
  Each contains:
  - `.claude-plugin/plugin.json`
  - `commands/<verb>.md` slash commands (review, rescue, status,
    result, cancel, setup; for Codex add adversarial-review)
  - `agents/<backend>-rescue.md` subagent definition
  - `scripts/companion.mjs` thin entry point
  - `package.json` depending on `@artagon/acp-plugin-lib` via
    `workspace:*`
- **`lib/transport/http.mjs`** — `HttpTransport` for Codex App Server.
  Spawns `codex --app-server`, holds connection over Unix socket or
  localhost HTTP, parses SSE event stream.
- **App Server translator** — separate from SDK translator because
  event shapes differ. `lib/backends/codex/app-server-translator.mjs`.
- **Codex backend extended**: `transports.http` factory added.
- **`marketplace.json`** at repo root listing all three plugins.
- **v1/v2 flag flip**: `ACP_PLUGIN_VERSION` defaults to `v2` after this
  change archives. v1 mode remains available for 30 calendar days.
- **v1 deprecation runway**: 30 days of side-by-side operation, then
  a deprecation warning, then v1 code removal in a future change.
- **Backwards-compat install**: existing `gemini-plugin-cc` install URL
  continues to work via marketplace redirect or alias entry.
- **Rollback procedure**: documented and dry-run tested before flag flip.

## Impact

- **Affected specs**: introduces `transport-http`, `plugin-shells`,
  `marketplace`. Modifies `monorepo-shape` (workspace globs activated).
  Modifies `feature-flags` (default flips).
- **Affected code**: significant restructure. `lib/` moves to its own
  package. New `plugins/` directories. Companion CLIs split.
- **User impact**: existing Gemini users see no change; new Claude and
  Codex plugins available for opt-in install. After 30-day runway, v1
  code paths removed in future change.

## Dependencies

- `add-claude-sdk-adapter` archived.
- All three backends working.
- Phase 0.2 verified marketplace redirect for repo rename.

## Risks and Mitigations

- **Workspace migration breaks paths**: codified in tasks; CI runs
  full test suite on every PR during migration.
- **Marketplace cache may be stale**: documented procedure to flush
  user-side cache; marketplace redirect verified in Phase 0.
- **HTTP transport lifecycle**: App Server is a long-running process,
  different lifecycle from short-lived CLI subprocess. Documented in
  spec; integration tests cover server crash, port conflict, multiple
  sessions sharing one server.
- **v2 flag flip risk**: rollback procedure documented and dry-run
  tested before flip. Rollback is a single revert PR.

## Estimated Effort

3 weeks one engineer.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
