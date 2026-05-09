# Glossary

Project-specific terms used across the OpenSpec change set.

**ACP** — Agent Client Protocol. The JSON-RPC protocol Claude Code
uses to communicate with external coding agents. Methods include
`session/new`, `session/prompt`, `session/cancel`, and notifications
like `session/update`, `session/request_permission`.

**AcpSession** — The plugin's interface representing one active
session against a backend. Defined as a JSDoc-typed contract in
`lib/acp/types.mjs`. All transports and backends conform.

**Backend** — A vendor (Gemini, Codex, Claude) plus the metadata
needed to talk to it: model aliases, supported transports, env
contributors, error mapping. Examples: `geminiBackend`,
`codexBackend`, `claudeBackend`. Lives in `lib/backends/`.

**Transport** — The wire mechanism for an `AcpSession`. After the
2026-05-08 CLI-only pivot, the project ships exactly one transport
in production: `CliTransport` (subprocess with stdio framing). The
`SdkTransport` (in-process vendor SDK + translator) and
`HttpTransport` (long-running HTTP+SSE) prototypes were scaffolded
in earlier proposals then deleted; the OpenAI Chat Completions HTTP
facade at `lib/server/openai-facade.mjs` is a SERVER, not an
`AcpSession` transport — it sits in front of the dispatcher and
routes requests to the appropriate `runStatelessTurn(...)` runner.

**Translator** — Originally defined as a pure function used by
`SdkTransport` to map vendor SDK events to ACP `session/update`
shapes. After the CLI-only pivot the same role is filled by the
per-runner `translate<Backend>StreamEvent` functions in
`lib/translate/` (e.g. `translateClaudeStreamEvent`,
`translateCodexStreamEvent`, `translateGeminiStreamEvent`). They
take a parsed stream-json line and return a `SessionUpdate`-shaped
object or null.

**Conformance test suite** — A fixed set of tests in
`lib/test-utils/conformance.mjs` that any `AcpSession` implementation
can be run against. Validates session lifecycle, prompt round-trips,
cancellation, permission flow, health transitions. New transports and
backends must pass.

**Middleware** — A function that wraps an `AcpSession` to add a
cross-cutting concern: redaction, audit, cost tracking, retry,
fallback, cache. Composed in canonical order via
`composeMiddleware([...])`. Redaction is always index 0.

**Plugin shell** — A host-installable plugin: a directory with
either `.claude-plugin/plugin.json` (Claude Code) or
`.codex-plugin/plugin.json` (Codex CLI) — both files are
byte-identical and CI enforces parity. `commands/<verb>.md` files,
optional `agents/` and `scripts/`. Three shells exist:
`plugins/{gemini,codex,claude}/`. Each is independently installable
into either host that supports the plugin contract.

**Marketplace** — A host's plugin discovery mechanism. The project
ships TWO marketplace descriptors at the repo root:
`.claude-plugin/marketplace.json` (Claude Code's path; string-form
`source: "./plugins/<name>"`, no `policy` block) and
`.agents/plugins/marketplace.json` (Codex CLI's canonical path per
the OpenAI plugin spec; structured
`source: { source: "local", path: ... }` with `policy` and
`interface.displayName`). Both descriptors list all three plugins
so a user installing into either host can pick any of them.

**Slash command** — A user-facing command invoked in Claude Code as
`/<plugin>:<verb>`, e.g., `/gemini:review`, `/codex:rescue`.
Implemented in the plugin shell.

**Wire log** — Optional JSONL capture of every JSON-RPC frame
(in either direction). Activated by `ACP_WIRE_LOG=<path>`. Format
matches test fixture format. Used to convert real bug repros into
regression tests.

**Health label** — The current state of a session as observed by
the transport: `active`, `quiet`, `possibly_stalled`, `rate_limited`,
`auth_required`, `worker_missing`, `broker_unhealthy`, `failed`.
Surfaces via `health()` method, log lines on transitions, and OTel
span events.

**Degraded mode** — Translator's fallback when an SDK event cannot
be translated cleanly. Rather than blocking the session, the
translator returns null, increments a counter, logs at warn or error,
and the session continues with reduced fidelity.

**ACP_PLUGIN_VERSION** — The `v1` / `v2` toggle for plugin behavior.
v1 is the original single-Gemini-plugin shape. v2 is the multi-plugin,
multi-backend shape. Default flips from v1 to v2 in
`add-app-server-transport-and-marketplace-split`. v1 remains opt-in
for 30 calendar days after flip.

**Stage gate** — The go/no-go decision point between Stage 1 and
Stage 2. Criteria include test coverage, mutation score, conformance
of a hypothetical new backend (Bedrock paper exercise), wire-log →
fixture pipeline proven on a real bug, retro doc completed.

**Pivot policy** — Stage gates also serve as scope-change checkpoints.
Within a stage, scope is locked except for narrowly-defined hotfixes.
Between stages, Stage 2 can be re-scoped against current intent.

**Drift CI** — Nightly cron job running translator snapshot tests
against the latest versions of pinned vendor SDKs and CLIs. Drift
posts to a tracking issue without failing main CI.

**Changesets** — `@changesets/cli` for versioning and changelog
generation. Per-package versioning in the workspace. CI enforces
that PRs touching code include a changeset (docs-only PRs exempt).
