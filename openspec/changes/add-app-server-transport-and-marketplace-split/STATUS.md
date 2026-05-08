# STATUS: PARTIALLY OBSOLETE

This change bundled two distinct concerns:

1. **App-server (HTTP/SSE) transport** — superseded by the CLI-only
   pivot (2026-05-08). `lib/transport/http.mjs` was deleted along
   with its tests.
2. **Marketplace split into three plugins** (claude, codex, gemini) —
   **still active**. The motivation and the plugin shape decisions
   in `proposal.md` remain valid; only the transport mechanism has
   changed.

## What's still relevant

The marketplace-split portion describes:

- `marketplace.json` listing three plugins with byte-equivalent
  manifests under `.claude-plugin/` and `.codex-plugin/`.
- Per-plugin shells under `plugins/{claude,codex,gemini}/` each with
  their own `commands/`, `agents/`, `hooks/`, `prompts/`, `schemas/`.
- Workspace scaffolding (`packages: []`) so the lib/ surface can
  evolve into a dedicated workspace package without breaking
  consumers.

That work is **not yet done** in the shipping codebase — `plugins/`
currently contains only `gemini/`. When the multi-plugin marketplace
work resumes, the proposal here is the right starting point; just
ignore any references to `lib/transport/http.mjs` and the
app-server-spawning workflow.

## What's obsolete

- T6.x (HTTP transport tests, app-server-spawning helpers).
- Anything referencing `lib/transport/http.mjs` or the SSE event-loop
  shape — that surface no longer exists.
- The Codex `transports.http()` factory mention — `codexBackend`
  now exposes only `transports.cli()`.

## Path forward

If/when the marketplace split is taken up, author a fresh OpenSpec
change focused only on the per-plugin shell + marketplace.json
generation. The transport selection inside each plugin is now a solved
problem (CLI only).

## Reading order

1. This file (status).
2. `proposal.md` here — the marketplace-split sections (T1, T2, T6.1
   "marketplace generation") remain valid; T6.4-T6.6 (HTTP transport,
   app-server lifecycle, SSE testing) are dead.
3. `docs/architecture.md` — current single-plugin layout.
