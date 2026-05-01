# acp-plugins-cc — Architecture Overview

A 1-page summary of the system. For deep detail, see the OpenSpec
change proposals and the per-capability spec files.

## What this is

A Claude Code plugin suite that lets Claude delegate, review, and
collaborate with three AI coding agents — Gemini, Codex, and Claude
itself — through a uniform interface. The user invokes
`/<backend>:review`, `/<backend>:rescue`, etc., and the plugin
dispatches to the chosen backend.

## Layered architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code (host)                                          │
│  - registers plugins discovered from marketplace.json        │
│  - issues slash commands                                     │
└─────────────────┬────────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────────┐
│  Plugin shells       plugins/{gemini,codex,claude}/          │
│  - .claude-plugin/plugin.json                                │
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
│  - cli.mjs    — subprocess + stdio framing                   │
│  - sdk.mjs    — in-process SDK + translator                  │
│  - http.mjs   — long-running App Server + SSE                │
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

| Want to add… | Touch… |
|---|---|
| A new backend (e.g., Bedrock) | `lib/backends/<name>/`, declare `<name>Backend` in the same shape as existing ones; pick which transports it supports |
| A new transport (e.g., gRPC) | `lib/transport/<name>.mjs`, conform to `AcpSession`, pass the conformance suite |
| A new translator (for an SDK) | `lib/backends/<name>/translator.mjs`, function `(event) => SessionUpdate \| null` |
| A new middleware concern | `lib/middleware/<name>.mjs`, slot into the canonical chain order; redaction MUST be index 0 |
| A new slash command | `plugins/<backend>/commands/<verb>.md` and a handler in `scripts/companion.mjs` |
| A new plugin shell | `plugins/<name>/` with manifest, commands, agents, scripts |

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
- **Trunk-based development**. Single main branch. v2 features behind
  `ACP_PLUGIN_VERSION=v2` until the flip in
  `add-app-server-transport-and-marketplace-split`. After flip, v1
  remains opt-in for 30 calendar days.

## Pointers for newcomers

- Read `glossary.md` for ACP/transport/backend terminology
- Read `project.md` for the dependency DAG of changes
- Read `changes/modernize-toolchain/design.md` for the toolchain
  decision rationale
- Read `changes/add-transport-abstraction-with-gemini/specs/acp-core/spec.md`
  for the canonical AcpSession contract
- Read the conformance suite source (location: `lib/test-utils/conformance.mjs`
  after Phase 4 implementation) for the executable behavioral contract
