# Review Round 3 — Security & Operations

**Reviewer lens**: secrets handling, authentication, rollback paths,
blast radius of failures, supply-chain risk, what an SRE/security
engineer asks before approval.

**Method**: read each spec for credential handling, file-system
permissions, error handling that could mask security issues, rollback
gaps, and operational invariants.

---

## Cross-cutting findings

### B-1: ~/.acp-plugins/ permissions not specified

The middleware proposal writes audit logs and metrics to
`~/.acp-plugins/...`. No spec sets file-mode bits. Default `umask`
varies (022 vs 077). On a shared machine, audit logs (containing
prompts) become world-readable.

**Fix**: spec MUST require `0700` on directories and `0600` on files
under `~/.acp-plugins/`. Add to middleware spec. Apply at directory
creation time.

### B-2: Rollback procedure for middleware proposal missing

Proposal 7 introduces middleware as the default chain. If a middleware
bug surfaces post-release (e.g., redaction misses a pattern),
rollback isn't specified. Earlier proposals (`add-app-server-transport-and-marketplace-split`)
have explicit rollback; this one doesn't.

**Fix**: add Rollback section to proposal 7. Strategy: middleware can
be disabled per-instance via env var (`ACP_DISABLE_MIDDLEWARE=cache,fallback`).
If a critical bug is found, users can disable the affected middleware
without reverting the release.

### M-3: Drift CI exposing API keys in logs

Drift CI runs translator snapshot tests against latest SDK versions.
If the SDK's error messages embed request payloads (some do for
debugging), test output may capture keys.

**Fix**: drift CI runs use a redaction-pass on log output before
publishing. Add scenario in release-engineering spec.

### M-4: Marketplace install integrity not verified

Spec doesn't address: what if an attacker compromises the marketplace
repo and pushes a malicious update? Users running
`claude plugin install <name>@artagon-acp` get the update transparently.

**Fix**: out of scope for this proposal set (Claude Code marketplace
security model is upstream's responsibility), but a note in
`docs/security.md` is warranted: pin to specific tags via
`@artagon-acp@v2.0.0` if the user needs immutability.

### M-5: Wire log retention not specified, may persist for forensics

Wire log captures all JSON-RPC traffic (including redacted secrets).
If a user enables it for debugging and forgets, the file accumulates
indefinitely. Even with rotation, there's no retention.

**Fix**: wire log SHALL warn at session end if `ACP_WIRE_LOG` is set,
reminding the user to disable or move the file. Plus: if the file
exceeds a configurable size warning threshold (e.g., 50 MB), an info
log notes it.

---

## Per-proposal findings

### `modernize-toolchain`

#### M-1.1: pnpm-lock.yaml integrity not verified

Spec asserts `pnpm install --frozen-lockfile` in CI. Doesn't specify
checksum verification. pnpm includes integrity hashes per package; if
those are tampered with locally, the install fails — but the spec
doesn't say so.

**Fix**: add scenario "Lockfile integrity check" — if the lockfile
references a package with a tampered tarball, install fails.

#### M-1.2: Husky hooks bypassable; no enforcement at server side

Husky checks at commit time but `--no-verify` bypasses. CI catches
violations, but the gap is "developer commits something bad locally,
pushes, CI catches before merge." Acceptable but worth stating
explicitly.

**Fix**: scenario already covers `--no-verify`; add explicit note that
server-side enforcement is via CI, not git hooks.

### `add-testing-and-observability`

#### B-2.1: Test fixtures may capture sensitive data accidentally

`tests/integration/fixtures/` contains JSONL fixtures derived from
real backend sessions. If a contributor forgets to scrub, sensitive
prompts or paths could end up in version control.

**Fix**: add Requirement "Fixtures pass redaction check before commit."
A pre-commit check (or CI gate) runs the fixture file through the
redaction pipeline; if any secret patterns survive, the commit/PR
fails.

#### M-2.2: OTel exporter URL leak

If `OTEL_EXPORTER_OTLP_ENDPOINT` points to an external collector
(e.g., a hosted observability vendor), spans containing prompt content
go off-prem. Spec doesn't warn about this.

**Fix**: scenario "OTel destination is logged on activation" — when
OTel activates, an info log explicitly states the destination. User
can verify they're sending to localhost or an authorized collector.

#### M-2.3: Wire log redaction patterns may not match all SDK shapes

Wire log redaction list is finite (specific field paths). Codex SDK
or Claude SDK could emit secrets in fields not in the list (e.g., a
config dump under `_internal`).

**Fix**: cross-reference: the value-pattern redactor (added in Round 2
via `lib/redaction-rules.mjs`) applies to wire log too. Spec already
has this; verify both sides reference the shared rules.

### `add-transport-abstraction-with-gemini`

#### B-3.1: stderr capture spec doesn't redact

`CliTransport` routes subprocess stderr to logger at warn level.
Backends sometimes log auth errors with credential values to stderr
(known bug in some older Codex CLI versions). The plugin's logger
redaction applies to *its own* log calls, but a subprocess line
piped through to the logger is just a string.

**Fix**: stderr lines from subprocesses SHALL pass through the
value-pattern redactor (same one used by wire log) before logging.
Add scenario.

### `add-codex-sdk-backend`

#### B-4.1: Auth file reading without integrity check

Spec says SDK reads `~/.codex/auth.json` when no explicit key. If
the file is world-readable (no permission check), or symlinked from
elsewhere, malicious local actor can substitute credentials.

**Fix**: backend SHALL warn (not fail) if `~/.codex/auth.json` has
permissive mode bits or is a symlink. User-actionable warning.

#### M-4.2: E2E API key in CI secret store

CI uses `OPENAI_API_KEY_E2E_CODEX` secret. If the CI runner is
compromised or a PR triggers the secret-bearing workflow, leak.

**Fix**: spec already requires nightly cron + dedicated key with
budget cap. Add: secret SHALL NOT be available to PR workflows from
forks (use environment protection). Document in `docs/e2e-policy.md`.

### `add-claude-sdk-adapter`

#### B-5.1: Permission bypass mode could be enabled accidentally

`bypassPermissions` mode auto-approves all tool calls. The spec says
"SHALL NOT be the default." But what stops a contributor from setting
it as default in a future change? No structural protection.

**Fix**: add Requirement "bypassPermissions requires explicit user
opt-in with warning." When the plugin starts with this mode, it logs
at warn level, prints a one-line user-visible message
("Tool calls auto-approved this session"), and re-prompts every N
sessions to reconfirm.

#### M-5.2: Credentials.json permissions

Same as Codex auth.json: claudeBackend reads the file silently.
World-readable file is a leak vector.

**Fix**: same warning pattern as Codex (B-4.1).

### `add-app-server-transport-and-marketplace-split`

#### B-6.1: Local HTTP server binds to what interface?

`HttpTransport` spawns App Server on `localhost`. Spec doesn't
specify the bind interface. If App Server defaults to `0.0.0.0`,
other machines on the network can connect.

**Fix**: add Requirement "App Server binds to loopback only" — the
spawn command MUST include explicit `--bind 127.0.0.1` (or
equivalent). Add scenario.

#### B-6.2: Plugin marketplace doesn't sign the marketplace.json

Anthropic's plugin marketplace model: anyone can publish. If a user
trusts the `artagon` org, they trust subsequent updates. If org is
compromised, downstream users are vulnerable.

**Fix**: out of scope (upstream marketplace problem). Note in
`docs/security.md`: pin to a specific git tag for reproducibility.

#### M-6.3: Codex `--app-server` may launch with full sandboxing off

Codex App Server has multiple sandbox modes. Spec doesn't specify
which mode the plugin uses. If launched with unsandboxed mode, tools
have full filesystem access.

**Fix**: spec SHALL require `--sandbox=workspace-write` (or the
strictest mode that supports the plugin's needs) by default.
Documented in `docs/backends/codex.md`. Add scenario.

### `add-middleware-and-release`

#### B-7.1: Audit log can grow unbounded across sessions

Spec mentions per-session daily rotation but doesn't address: number
of session directories. If the plugin runs hundreds of sessions a
day, `~/.acp-plugins/audit/` accumulates hundreds of subdirectories.

**Fix**: add Requirement "Audit log directory has a session count
cap" — directories older than retention are removed by cleanup; max
2000 active session dirs at any time; oldest evicted past cap.

#### B-7.2: Cache stores serialized context; what about file contents?

Cache key includes "serialized context" — but the cache value is the
backend's response. If the response includes file contents read by
the backend's tools, the cache stores that content too. Reading the
cached response later effectively replays a file that may have
changed.

**Fix**: clarify cache scope. Cache stores ACP-level responses (text
output and tool_call announcements), not file contents that tools
read mid-execution. For commands that don't trigger tools (review,
adversarial-review), this is a non-issue.

#### M-7.3: Secret in prompt → cache → on-disk plaintext

Cache stores prompts on disk. Prompts may contain context (file
contents) that include secrets the user doesn't realize. The
redaction middleware redacts known patterns, but custom secret formats
slip through.

**Fix**: cache files SHALL be 0600 mode under `~/.acp-plugins/cache/`.
Document in `docs/cache.md`: cached prompts contain redacted but
otherwise verbatim user content. Users with high security needs can
disable cache.

#### M-7.4: Drift CI publishes upstream's bugs

If drift CI surfaces a bug in upstream SDK, that's public information
in the tracking issue. Could embarrass upstream or prompt CVE-style
disclosure.

**Fix**: drift issues are in our repo; we don't publish CVEs. Drift
findings SHALL be reported privately to upstream first, then publicly
after a documented disclosure window. Add to release-engineering.

#### M-7.5: Changeset metadata may leak

Changesets are public. A changeset description could mention a fixed
security issue specifically. If we fix a vulnerability, the changeset
notes telegraph the vulnerability before users update.

**Fix**: security-impacting changes SHALL use generic changeset
descriptions ("dependency update") and detailed advisory privately.
Documented in `docs/security.md`.

---

## Verdict

7 proposals, 23 findings (8 blocking, 11 major, 4 notes).

**Blockers worth applying before Round 4**:
1. File-mode bits 0700/0600 on `~/.acp-plugins/` (B-1)
2. Rollback procedure for middleware proposal (B-2)
3. Fixture redaction check (B-2.1)
4. Subprocess stderr redacted (B-3.1)
5. Auth-file permission warnings (B-4.1, applies to Claude too)
6. bypassPermissions explicit opt-in scenario (B-5.1)
7. App Server bind to loopback (B-6.1)
8. Audit log directory cap (B-7.1)

Status: **Changes requested**.
