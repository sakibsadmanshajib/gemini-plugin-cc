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

**Transport** — The wire mechanism for an `AcpSession`. Three kinds
exist: `CliTransport` (subprocess with stdio framing), `SdkTransport`
(in-process vendor SDK plus translator), `HttpTransport` (long-running
HTTP+SSE server). Transports do not know vendor specifics; they call
backend-supplied hooks.

**Translator** — A pure function used by `SdkTransport` to convert
vendor SDK events to ACP `session/update` shapes. Type:
`(event) => SessionUpdate | null`. Returning null indicates an
event with no ACP-level meaning. Errors during translation throw,
returning to the transport's error handler.

**Conformance test suite** — A fixed set of tests in
`lib/test-utils/conformance.mjs` that any `AcpSession` implementation
can be run against. Validates session lifecycle, prompt round-trips,
cancellation, permission flow, health transitions. New transports and
backends must pass.

**Middleware** — A function that wraps an `AcpSession` to add a
cross-cutting concern: redaction, audit, cost tracking, retry,
fallback, cache. Composed in canonical order via
`composeMiddleware([...])`. Redaction is always index 0.

**Plugin shell** — A Claude Code plugin: a directory with
`.claude-plugin/plugin.json`, `commands/<verb>.md` files, optional
`agents/` and `scripts/`. Three shells exist:
`plugins/{gemini,codex,claude}/`. Each is independently installable.

**Marketplace** — Claude Code's plugin distribution mechanism.
Listed via a top-level `.claude-plugin/marketplace.json`.

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
