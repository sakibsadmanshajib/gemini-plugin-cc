# STATUS: OBSOLETE

This change proposed adding a Codex backend with three transports
(`sdk`, `cli`, `http`). It has been **superseded by the CLI-only pivot
(2026-05-08)**.

## What replaced it

- `lib/backends/codex.mjs` ships the Codex backend declaration.
- It exposes a single `transports.cli` factory — no SDK, no HTTP/SSE
  app-server transport.
- `buildCodexArgs(config)` is the pure argv builder, exported and
  unit-tested in `tests/unit/cli-args-builders.test.mjs`.
- See `docs/backends/codex.md` for the current contract and
  `docs/cli-options-research.md` for the per-backend flag taxonomy.

## Why the SDK approach was abandoned

In November 2026 the project pivoted to "CLI-only adapters with
CLI-specific optimization options" per direct user direction. The
in-process SDK approach was dropped because:

1. The CLI surface is the project's authoritative integration point
   (slash commands shell out to the binary; ACP mode owns session
   lifecycle in-band).
2. SDK adapters required maintaining two parallel translators per
   backend (Codex events ↔ ACP, Claude events ↔ ACP) for thin
   benefit over CLI's existing JSON-RPC framing.
3. The HTTP/SSE app-server transport added a third deployment shape
   that no consumer was actually using — pure architectural debt.

The translator code (`lib/backends/codex/translator.mjs`,
`lib/backends/claude/translator.mjs`) and the SDK + HTTP transport
modules (`lib/transport/sdk.mjs`, `lib/transport/http.mjs`) were
removed. The associated test files (4 files, ~41 tests) went with them.

## Reading order

If you're investigating Codex backend history:

1. This file (status).
2. `proposal.md` and `tasks.md` here (the original SDK-first plan).
3. `lib/backends/codex.mjs` (current shipping declaration).
4. `tests/unit/cli-args-builders.test.mjs` (`buildCodexArgs` argv tests).
5. `docs/backends/codex.md` (current docs).
