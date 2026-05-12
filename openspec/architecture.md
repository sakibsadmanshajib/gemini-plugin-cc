# artagon-agent-cli-plugin — Architecture Overview

A 1-page summary of the system. For deep detail, see the OpenSpec
change proposals and the per-capability spec files.

## What this is

A multi-host plugin suite that lets Claude Code, Codex CLI, and
Gemini hosts each delegate, review, and collaborate with the OTHER
two AI coding agents through a uniform interface. The user invokes
`/<backend>:review`, `/<backend>:rescue`, etc., and the plugin
dispatches to the chosen backend via stateless CLI runners or the
OpenAI Chat Completions HTTP facade.

## Layered architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Host: Claude Code OR Codex CLI                              │
│  - registers plugins from marketplace.json (both formats)    │
│  - issues slash commands                                     │
└─────────────────┬────────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────────┐
│  Plugin shells       plugins/{gemini,codex,claude}/          │
│  - .claude-plugin/plugin.json + .codex-plugin/plugin.json    │
│  - commands/<verb>.md                                        │
│  - scripts/companion.mjs (thin orchestrator)                 │
└─────────────────┬────────────────────────────────────────────┘
                  │ imports @artagon/acp-plugin-lib
┌─────────────────▼────────────────────────────────────────────┐
│  Middleware chain    lib/middleware/                         │
│  redaction → audit → cost → retry → fallback → cache         │
└─────────────────┬────────────────────────────────────────────┘
                  │ wraps an AcpSession
┌─────────────────▼────────────────────────────────────────────┐
│  Backends            lib/backends/{gemini,codex,claude}/     │
│  - declares modelAliases, transports, setupHints              │
│  - vendor-specific error mapping, env contributors           │
└─────────────────┬────────────────────────────────────────────┘
                  │ creates a transport per session
┌─────────────────▼────────────────────────────────────────────┐
│  Transports          lib/transport/                          │
│  - cli.mjs    — subprocess + stdio framing (the only         │
│                 surviving transport after the 2026-05-08      │
│                 CLI-only pivot; sdk.mjs + http.mjs were       │
│                 prototyped then deleted)                      │
└─────────────────┬────────────────────────────────────────────┘
                  │ all conform to AcpSession (lib/acp/types.mjs)
┌─────────────────▼────────────────────────────────────────────┐
│  ACP core            lib/acp/                                │
│  - JSON-RPC framing                                          │
│  - request/response correlation                              │
│  - notification dispatch                                     │
└──────────────────────────────────────────────────────────────┘
```

## Where to add things

| Want to add…                  | Touch…                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A new backend (e.g., Bedrock) | `lib/backends/<name>/`, declare `<name>Backend` in the same shape as existing ones; pick which transports it supports                                        |
| A new transport (e.g., gRPC)  | `lib/transport/<name>.mjs`, conform to `AcpSession`, pass the conformance suite                                                                              |
| A new translator (per-runner) | `lib/translate/<backend>-stream-event.mjs`, function `(streamJsonLine) => SessionUpdate \| null` (post-pivot path; SdkTransport-backed translators are gone) |
| A new middleware concern      | `lib/middleware/<name>.mjs`, slot into the canonical chain order; redaction MUST be index 0                                                                  |
| A new slash command           | `plugins/<backend>/commands/<verb>.md` and a handler in `scripts/companion.mjs`                                                                              |
| A new plugin shell            | `plugins/<name>/` with manifest, commands, agents, scripts                                                                                                   |

## Key invariants

- **Redaction is first** in the middleware chain. Audit, logs, traces,
  cost — all see redacted content. Enforced at `composeMiddleware`
  validation time.
- **AcpSession is the contract**. All transports and backends conform.
  Verified by `runConformanceSuite` against every implementation.
- **stdout is the wire**. The plugin process's stdout carries JSON-RPC
  to the host. Logs go to stderr. Wire-log goes to a file. No
  log-to-stdout exceptions.
- **Backend env is allowlisted**. `CliTransport` does not pass the
  parent's full env to subprocesses. Default allowlist + per-backend
  contributions.
- **State schema is versioned**. v1 state files migrate forward in
  memory; v2 state files include explicit `schemaVersion`.
- **Trunk-based development**. Single main branch. The
  `ACP_PLUGIN_VERSION` flag was originally designed to gate the v1→v2
  cutover (default flip in
  `add-app-server-transport-and-marketplace-split`, with v1 opt-in
  for 30 calendar days after flip), but the multi-backend behavior
  shipped via the rebrand without going through that flag-gated
  cutover. The flag remains plumbed at
  `lib/feature-flags.mjs::getPluginVersion` for future opt-in
  behavior toggles; see the glossary entry for current state.
- **Facade daemon is operator-bootable, slash-command-auto-bootable**.
  `bin/artagon-openai-server` is a long-lived process that owns warm
  streaming runners for all three backends. Slash-commands auto-spawn
  it via `lib/server/auto-start.mjs::autoStartFacade` (proper-lockfile-
  serialized, circuit-breaker-gated). Discovery is via
  `$XDG_STATE_HOME/artagon-agent-cli-plugin/facade-endpoint.json`;
  stale-manifest recovery uses atomic rename + verify + restore-via-
  link (`compareAndDeleteManifest`). `GET /admin/status` reports
  per-supervisor health with a redacted `LastErrorCode` enum
  (full message stays in the daemon stderr log; the enum prevents
  leaking filesystem paths or auth hints through the unauthed
  endpoint when `--api-key` is unset). See `docs/openai-facade.md`.

## Pointers for newcomers

- Read `glossary.md` for ACP/transport/backend terminology
- Read `config.yaml` (`context:` section) for the project-shape and
  authoring conventions, or `../docs/agent-cli-design.md` for the full
  dependency DAG, effort estimates, and stage-gate checklist
- Read `changes/modernize-toolchain/design.md` for the toolchain
  decision rationale
- Read `changes/add-transport-abstraction-with-gemini/specs/acp-core/spec.md`
  for the canonical AcpSession contract
- Read the conformance suite source (location: `lib/test-utils/conformance.mjs`
  after Phase 4 implementation) for the executable behavioral contract
- Read `../docs/openai-facade.md` for the HTTP facade endpoint reference
  (including `/admin/status` with the `LastErrorCode` enum table) and
  `../docs/architecture.md`'s "Unified-facade daemon" section for the
  daemon-mode operator flow
