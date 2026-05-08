# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **OpenAI facade error response builder consolidated**. The
  `{error: {message, type, code?, param?, backend?}}` shape was
  rebuilt inline at 8 call sites. New `sendError(res, status,
message, opts)` helper centralizes the wrapper. Default
  `type: "invalid_request_error"` matches the common case (5 of 8
  sites); optional code / param / backend stay declarative. Net
  -45 +18 lines in the call sites; 61/61 facade tests pass
  unchanged.

- **HTTP body parsing in OpenAI facade migrated to `raw-body` 3.0.2**.
  The hand-rolled `readJsonBody` was reimplementing chunk-buffering +
  size-cap + drain-without-destroy. We already had to fix it once
  (c238fa5 ECONNRESET race when destroying mid-write); raw-body
  handles drain-vs-destroy correctly out of the box. Net -35 +9
  lines. The 413 detection switched from string-matching err.message
  to `err.statusCode === 413` — structural, not stringly-typed. 61/61
  facade tests pass unchanged.

- **Argv parsers across all entry points migrated to `commander` 14.0.3**.
  The four hand-rolled `parseArgs` functions in `bin/artagon-stats`,
  `bin/artagon-agent`, `bin/artagon-openai-server`, and
  `scripts/generate-homebrew-formula` were reimplementing what
  commander has done correctly for a decade — `--help` formatting,
  `--version` handling, unknown-flag rejection, missing-value
  detection, type coercion. Net -445 / +368 lines (77 fewer
  maintained). Per-flag validators (parseIso, parsePositiveInt,
  parsePositiveNumber, parsePort, parseBackend) throw
  InvalidArgumentError to wire into commander's standard error path.
  Exit codes preserved (0 / 1 / 2 / 3) via `program.exitOverride`.
  Test assertions updated to commander's standard error wording —
  semantics unchanged.

  Note: `scripts/generate-homebrew-formula`'s prior `--version <ver>`
  flag conflicted with commander's auto-injected `--version` (which
  prints package version + exits). Renamed to `-V, --pkg-version
<ver>` since the original semantics would have surprised users
  hitting the auto-flag.

### Security (CodeQL findings on PR #4 — all 11 addressed)

- **CRITICAL ReDoS in `extractBearerToken`**: replaced
  `/^Bearer\s+(.+)$/i` with a fixed-length string parse (no regex,
  no backtracking, faster).
- **HIGH stack-trace exposure** in both streaming and non-streaming
  backend_error response paths: detail logged to stderr server-side;
  clients see only "<backend> backend failed; check server logs for
  detail".
- **HIGH × 6 insecure-tmp-file in tests + MEDIUM file-data-in-network
  in scripts/**: false positives (mkdtempSync-derived helpers / a
  release-time tool that intentionally fetches `registry.npmjs.org`).
  Added `.github/codeql-config.yml` with `paths-ignore: tests/**,
scripts/**` and wired the workflow's `init` to use it.
  `bin-artagon-stats.test.mjs` also tightened to use mkdtempSync as
  defense-in-depth.

### Added

- **`bin/artagon-stats --budget <n>` and `--budget-usd <n>`**: shell-side
  CI gating for cost overruns. Token + USD budgets were already
  reachable via the in-host `/<plugin>:budget` slash commands but had
  no shell counterpart. Exit code 3 distinguishes "over budget" from
  clean (0) and usage error (2), so CI scripts can branch:
  `case $? in 0) ;; 2) exit 1 ;; 3) alert ;; esac`. `--json` output
  gains a `budget` block with `{tokens, usd, over, message}`.

- **`bin/artagon-stats` test suite** (14 cases). Covers argv parsing
  (--version, --help, unknown flag, invalid --since / --budget /
  --budget-usd), empty-log handling, populated-log summary rendering
  with cost line, --json budget block, --budget exit 3 + stderr
  OVER BUDGET message, --budget-usd exit 3 with $-formatted message,
  --recent N filtering. Each test uses a per-test temp
  `ARTAGON_COST_LOG` so no cross-test state.

- **OpenAI compatibility hardening on the HTTP facade**:
  - **Opt-in API-key auth** (`apiKey` option + `--api-key` flag +
    `--api-key-file <path>` flag + `$ARTAGON_FACADE_API_KEY` env).
    Closes a deployment-misconfig hazard: the facade had no defense
    if the user bound to 0.0.0.0 (Docker port-mapping). When set,
    every `/v1/*` request must carry `Authorization: Bearer <key>`;
    `/health` is exempt (LB probe convention). Constant-time
    comparison via `crypto.timingSafeEqual` prevents char-by-char
    timing-leak attacks. Multi-key allowlists supported (key
    rotation). `--api-key-file` reads from a 0o600-safe file —
    safer than `--api-key` since the latter is visible in
    `ps -ef` output.
  - **Opt-in CORS** (`cors` option + `--cors` flag on
    `bin/artagon-openai-server` + `$ARTAGON_FACADE_CORS` env). Browser
    clients (Vercel AI SDK, in-browser openai SDK) couldn't reach
    the local facade due to same-origin policy and missing OPTIONS
    preflight handler. Default OFF for safety; supports wildcard,
    single origin, or comma-separated allowlist.
  - **`stream_options.include_usage`**: streaming clients can now
    opt into a final usage chunk before `[DONE]`. Was returning
    `response.usage = None` on streamed turns — broken token
    accounting.
  - **finish_reason mapping** to OpenAI's canonical set
    (`stop` / `length` / `content_filter` / `tool_calls` /
    `function_call`). Each backend's dialect (Claude `end_turn` /
    `max_tokens` / `tool_use`, Gemini uppercase `STOP` / `SAFETY` /
    `RECITATION`, Codex already-canonical) translates correctly.
    Without mapping, downstream `if reason == "length"` retry
    branches silently missed Claude/Gemini cases.
  - **Body parse failures return 400/413** instead of 500. Bad JSON
    - oversized bodies are CLIENT errors. `readJsonBody` no longer
      races with `req.destroy()` (was producing ECONNRESET).
  - **`n != 1` rejected with 400** + clear `param: "n"` pointer.
    Was silently returning `choices[0]` and clients indexing
    `choices[1..n-1]` got undefined.
  - **`bin/artagon-openai-server --cors <spec>`** flag exposes the
    facade's CORS option from the standalone CLI.

- **Homebrew formula generator**
  (`scripts/generate-homebrew-formula.mjs` / `pnpm gen:homebrew`).
  Reads version + name from `package.json`, fetches the published
  npm tarball, computes SHA-256, renders
  `artagon-agent-cli-plugin.rb` with `depends_on "node"` +
  `Language::Node.std_npm_install_args` install path + a smoke-test
  block exercising all 3 bin scripts via `--version`. Replaces the
  manual sed-loop SHA copy/paste described in the prior tap docs.

- **`SECURITY.md`** disclosure policy. Reporting via private GitHub
  Security Advisory (preferred) or `security@artagon.dev`. 3-day
  ack / 7-day assessment / 90-day default coordinated disclosure
  window. In-/out-of-scope sections + "hardening already in place"
  reviewer index pointing at CodeQL, SHA-pinned actions, OIDC
  provenance, SBOM, `crypto.randomBytes` IDs, mode-0o600 cost log,
  no-stack-trace responses, PID-reuse hardening. Repoints the
  security-report issue template's previously-placeholder email.

- **Prompt-cache aware USD pricing.** `lib/cost/recorder.mjs` now
  extracts Claude's `cache_creation_input_tokens` /
  `cache_read_input_tokens` and OpenAI's
  `prompt_tokens_details.cached_tokens` into normalized
  `cache_creation_tokens` / `cache_read_tokens` fields on
  `NormalizedUsage`. `lib/cost/pricing.mjs` honors per-backend
  cache multipliers (Claude write +25%, read 10%; OpenAI read 50%
  with subset-of-prompt subtraction). Without this, every cached
  token was billed at full input rate — significant over-estimation
  for prompt-cache users.
- **Cache savings surfaced in /stats.** `lib/cost/aggregate.mjs`
  adds `cache_creation_tokens` + `cache_read_tokens` aggregates plus
  a counterfactual `estimated_usd_without_cache`. The delta is the
  dollar value of cache hits; `formatCostSummaryText` emits a
  `Cache savings: $X.XX (N hits, M writes)` line when applicable.
  Per-backend totals also carry the cache fields.

### Fixed

- **CI duplicate runs.** Every PR commit was firing each workflow
  twice — once via the feature-branch `push` trigger
  (`chore/**`/`feat/**`/`fix/**`) and once via
  `pull_request: branches: [main]`. Visible as duplicate rows in
  `gh pr checks`. Dropped feature-branch push triggers in `test.yml`
  and `install.yml` (`pull_request` covers them; `push` only on
  `main` for post-merge gating). Added `concurrency` blocks with
  `cancel-in-progress: true` so rapid pushes cancel stale runs.

- **Property test substring-vs-structural bug.** `tests/property/
message-roundtrip.test.mjs` used `wire.includes('"id"')` to assert
  no top-level `id` on JSON-RPC notifications. fast-check found a
  counterexample where a nested `id` key inside `params` matched the
  substring even though the outer message was a valid notification.
  Switched to `Object.hasOwn(parsed, "id")` — only the top-level
  shape matters per the JSON-RPC notification rule.

- **CI install workflow was red on every commit since vitest tests
  were added.** Three steps in `.github/workflows/install.yml`
  (Run install-integration tests under Claude env / Codex env, Run
  broker-reaper tests, Run plugin-info tests) ran their target files
  via `node --test`, but each file imports from `vitest`. vitest's
  APIs only function under the vitest worker; under node:test they
  threw "Vitest failed to access its internal state". Switched all
  four invocations to `pnpm exec vitest run <file>`. Verified locally
  install.test.mjs passes 12/12 under both env shapes.
- **CodeQL findings (5)** addressed on PR #4:
  - 2× `js/insecure-randomness`: session-id generation in
    `lib/middleware/{audit,cost}.mjs` switched from `Math.random` to
    `crypto.randomBytes`. Same applied to chatcmpl-id generation in
    `lib/server/openai-facade.mjs` (extracted as
    `generateChatCompletionId()` helper).
  - 1× `js/stack-trace-exposure`: the global 500 catch in the OpenAI
    facade returned `err.message` to clients. Now writes the full
    stack to stderr server-side and returns a generic
    `"internal server error"`. Backend-level 502 errors still
    surface vendor CLI stderr (the user's own backend giving up).
  - 2× `js/unused-import`: dropped `SESSION_ID_ENV` from
    gemini-companion.mjs and `execFileSync` from
    plugins/gemini/scripts/lib/process.mjs.

- **Silent-failure cleanup across observability paths.** Several
  best-effort code paths swallowed errors so completely that
  operators had no signal when the path stopped working. Each is
  now visible without breaking the runtime:
  - **`lib/middleware/compose.mjs`** — the redaction-first invariant
    was downgraded from a hard throw to a stderr WARN under
    `NODE_ENV=production`. That failed-open in exactly the
    deployment where un-redacted secrets/PII flowing through audit
    - observability middlewares is most damaging. Now always throws
      regardless of environment; middleware composition happens once
      at app startup with statically-imported middlewares, so a wrong
      order is a programming bug, not a runtime condition. Test
      coverage extended to assert the prod path (previously
      untested — which is how the regression survived).
  - **`lib/middleware/audit.mjs`** — `ensureFd` swallowed the open
    failure's reason; "[audit] auditing disabled" gave operators
    no way to distinguish EACCES from ENOSPC from EROFS. Now
    appends `— <err.message>`. Separately, `record` silently
    dropped failed writes — the worst place to fail invisibly for
    a log whose entire purpose is integrity. First write failure
    surfaces; subsequent silenced via one-shot flag.
  - **`lib/middleware/cache.mjs`** — same one-shot pattern.
    Cache is `_cache: true` opt-in; silent mkdir/write failure
    meant a user explicitly enabling caching saw no perf benefit
    and no error.
  - **`lib/tracing.mjs`** — `getTracer()`'s catch comment claimed
    "OTel SDK not installed; degrade silently" but the catch
    covered the entire setup block (dynamic imports, NodeSDK
    construction, exporter construction, sdk.start()). A user
    with `OTEL_EXPORTER_OTLP_ENDPOINT` set + a malformed URL got
    empty Jaeger boards and no signal. Now discriminates on
    `err.code`: `ERR_MODULE_NOT_FOUND` keeps the silent no-op
    (legit "not installed" path); anything else emits a one-shot
    stderr warning.
  - **`lib/test-utils/mock-backend.mjs`** — JSON-RPC notification
    dispatcher swallowed handler exceptions. By spec a
    notification has no caller to return errors to, so the
    dispatcher can't re-throw — but silently swallowing meant a
    buggy test handler showed up as a stalled assertion or a
    flaky timeout, not a stack trace. Now writes the trace to
    stderr; behavior unchanged for the caller.

  All five preserve their best-effort semantics (audit/cache/
  tracing failures still don't propagate up the chain, mock-backend
  notifications still complete). Just no longer invisible.

### CI

- **`pnpm pack:check` script** for tarball verification before
  release — wraps `npm pack --dry-run` so contributors can confirm
  the tarball file list + size (~225 KB packed / ~750 KB unpacked /
  147 files) before tagging. The `npm-publish.yml` workflow's
  pre-publish "Verify tarball contents" step now routes through
  this same script, replacing a broken `pnpm pack --dry-run`
  invocation (pnpm 9.15 rejects --dry-run as an unknown option;
  the workflow would have errored on its first `v*` tag push, but
  no v\* tag has been pushed yet so the bug never surfaced).
- **`.github/workflows/test.yml` permissions hardened** — was the
  only workflow without an explicit top-level `permissions:` block.
  Default GITHUB_TOKEN scope can be permissive under some org
  policies. Pinned to `contents: read` (the only scope `actions/
checkout` needs in this workflow). Closes the OpenSSF Scorecard
  Token-Permissions gap for this file.
- **`.github/workflows/install.yml` regression baseline trimmed**
  from `pnpm test` (full ~600-test suite) to `pnpm test:unit`
  (~478 tests). The full suite already runs on every PR via
  `test.yml` (no paths: filter), and install.yml's subsequent
  steps re-run install.test.mjs 3×, broker-reaper.test.mjs 2×, and
  plugin-info.test.mjs 2× per node-version (matrix: 20.x + 22.x).
  Trim removes ~150s of pure duplication per PR; unit gate still
  catches typecheck-class breakage before the env-shape steps
  spawn child processes.

- **Test matrix dropped EOL Node 18.** `test.yml` continued running
  against Node 18 (EOL'd 2025-04-30) burning ~50s of runner time
  per PR validating a runtime no realistic downstream user runs
  anymore. `install.yml` had already trimmed to `[20.x, 22.x]`;
  this aligns `test.yml`. Floor now matches Node's actively-
  maintained LTS lines (20 through 2026-04, 22 through 2027-04).
  `package.json engines.node` left at `>=18.18.0` deliberately —
  bumping engines warrants its own SemVer signal and its own
  decision separately from a CI policy change.

- **Bin SIGINT/SIGTERM handling.**
  - `bin/artagon-agent` had no signal handler at all, so a Ctrl-C
    during a long backend turn relied on shell process-group signal
    propagation to kill the spawned claude/codex/gemini CLI — which
    is fragile (backend sets its own pgrp / briefly ignores SIGINT
    during cleanup / pipe through a process-group-changing tool).
    Now plumbs SIGINT/SIGTERM into an `AbortController` that flows
    through `runStatelessTurn({ signal })` to the runner's child-
    kill path. Deterministic cancellation, no orphaned subprocess.
  - `bin/artagon-openai-server`'s shutdown ignored the promise
    returned by `shutdown()` — a `facade.close()` rejection would
    print "unhandledRejection" at the worst possible moment (during
    shutdown, when stderr is the operator's only signal). Now
    wrapped in a `safeShutdown` boundary that catches and exits 1
    with a clean message. Also added a 10s `.unref()`'d safety
    timer that force-exits with code 1 + a clear message if
    `close()` hangs (stuck keep-alive connection, runner subprocess
    that won't yield). Without this, the operator was on
    Ctrl-C-Ctrl-C force-kill duty.

- **`bin/artagon-stats` clean error on cost-log read failure.**
  `readCostRecords` swallows per-line JSON parse failures (line-
  level corruption is recoverable) but throws on file-level errors
  (EACCES from a wrong-mode log file, EISDIR from a path collision,
  EROFS in some containers). The bin called it without a try/catch,
  so any of those produced a raw Node stack trace including
  internal `node:fs` frames at the user — operationally useless.
  Now wrapped: prints `artagon-stats: failed to read cost log:
<err.message>` and exits 1 (runtime error, not 2 / usage error
  — args were fine, environment is misconfigured). Symmetric with
  the existing `artagon-agent` and `artagon-openai-server` error
  patterns.

- **`bin/artagon-stats` text-mode default --recent 5.** README's
  Quick Examples claimed `artagon-stats` (no flags) shows
  "text summary + 5 most recent" but the actual behavior was: no
  recent records unless `--recent N` was explicitly passed —
  README drift since at least the 1.0 release. Defaulting `--recent
5` for text mode aligns the behavior with the documented
  contract. JSON output stays strictly opt-in (tooling parsing the
  output shouldn't get an unexpected `recent` field). Explicit
  `--recent N` (including `--recent 0` to suppress) takes
  precedence. Three new test cases lock the contract in.

### Tests added

- **`tests/unit/tracing.test.mjs`** — 9 unit tests pinning the
  no-op contract for `lib/tracing.mjs` (zero coverage prior).
  Covers: `getTracer({})` → no-op tracer; `getTracerSyncOrNoop`
  shape before async resolves; sync + async fn return passes
  through `tracer.span`; rejection inside `span` propagates to
  caller; `inject(carrier)` doesn't throw or mutate; `shutdown()`
  resolves; cache returns same instance; bogus env (import fails)
  → still a usable no-op (validates the silent-vs-warn
  discrimination at the catch boundary).

### Chore

- **`pnpm lint:fix` flag refresh.** Was emitting a deprecation
  warning on every run: `--apply` is deprecated, removed in next
  major biome. Pre-commit hook had already migrated to `--write`;
  aligned the npm script. Equivalent semantics in biome 1.9, just
  no more warning noise per invocation.

- **JSDoc-typed three IDE-visible noImplicitAny holdouts** in
  `lib/middleware/audit.mjs`, `lib/middleware/compose.mjs`, and
  `lib/tracing.mjs`. tsgo's full check accepted them but the
  language server flagged them at edit time. No runtime change —
  cleans up false-positive squiggles for authors working in these
  files.

- **`chmod +x` on `bin/*.mjs`** (was `100644` in git). The three
  bin entry points were checked in as non-executable, so a
  contributor running `./bin/artagon-agent.mjs --help` got
  "Permission denied". After `npm i -g`, end-user invocation went
  through npm's wrapper and was unaffected — but local dev and
  `npm link` workflows hit unnecessary friction. Used `git
update-index --chmod=+x` so blob SHAs are unchanged, only the
  mode prefix flipped (verified `git ls-files --stage`).

- **dependabot.yml runtime-deps comment clarified.** The docstring
  said "Group runtime patch/minor updates similarly" but the
  config grouped only `patch`. Updated the comment to spell out
  the rationale (minors deliberately land as solo PRs since they
  can introduce new flags / change error wording) so a future
  reader doesn't "fix" the perceived omission. Comment-only.

### Security

- **wire-log password redaction was corrupting field name to
  offset number.** The `password` redaction regex
  (`lib/wire-log.mjs`) was missing a capture group that the other
  three patterns had. `String.prototype.replace` passes the match
  OFFSET as the second callback argument when there's no
  capturing group — so `"password":"hunter2"` rendered as
  `"208":"[redacted]"` on disk, with the offset shifting per
  record. Three consequences: (1) on-disk JSON structure was
  technically valid but semantically wrong (the field name had
  vanished); (2) `grep password` against the wire log missed the
  redacted entries entirely; (3) the offset shift meant the
  output wasn't idempotent across runs, complicating diff-based
  review. Discovered while writing the first unit tests for
  `lib/wire-log.mjs`. Comment added on `REDACT_TOKENS` spelling
  out why every entry needs group 1, so a future addition doesn't
  hit the same trap.

- **`secret` field-name aligned across all three redaction
  layers.** The project has three independent redaction layers
  (`redaction.mjs` middleware, `wire-log.mjs`, `logger.mjs`) each
  acting as defense-in-depth nets for payloads that bypass the
  others. The middleware's `DEFAULT_FIELD_NAMES` listed `"secret"`
  but `wire-log` and `logger` didn't. A `{secret: "..."}` payload
  that bypassed the middleware (e.g. a direct `logger.info` call
  from broker code) would leak through the other two layers
  uncovered. Added `"secret"` to wire-log's `REDACT_TOKENS` and
  `"*.secret"` to logger's pino redact paths. Comment on
  `logger.mjs` now explicitly calls out the cross-file invariant.

- **`SECURITY.md` PGP-key claim removed.** Previous text promised
  a "PGP key fingerprint forthcoming" — a stale aspirational TODO
  that hasn't materialized. Replaced with honest guidance:
  `security@artagon.dev` is TLS-in-transit-only with no published
  PGP key; for sensitive material, prefer the GitHub private
  security advisory route (already preferred channel #1) which
  offers transport-equivalent protection plus access-controlled
  disclosure history.

### Tests added (continued)

- **`tests/unit/wire-log.test.mjs`** — 6 unit tests pinning the
  wire-log redaction contract (zero coverage prior; the tests
  caught the password→offset-number bug above). Covers no-op when
  ACP_WIRE_LOG unset; JSONL envelope shape; full 9-field default
  redaction (matching the cross-layer invariant); ACP_WIRE_LOG_RAW=1
  opt-out; defensive `RAW=true` should-stay-redacted; close-then-
  record best-effort.

- **`tests/property/wire-log-redaction.test.mjs`** — 2 fast-check
  properties (100 runs each). Property 1: every (fieldName,
  secretValue) pair → field value parses to `[redacted]` and the
  original value never appears in raw text. Property 2: every set
  of credential fields sharing one secret → output round-trips
  through `JSON.parse` cleanly with all values redacted. Self-test
  bug caught while writing — initial substring leak-check
  false-positived on `["apiKey", "K"]` (single-char "K" is a
  substring of "apiKey"); resolved by making the load-bearing
  assertion structural via JSON.parse and bumping minLength to 8.

### Repository hygiene

- **`.editorconfig`** already in place; added complementary
  **`.nvmrc` → 22** so nvm/fnm/volta/asdf-vm/mise users
  auto-switch to the project's Node version on `cd`. Matches
  `test.yml`'s primary lane and stays above `engines.node:
">=18.18.0"`.
- **`.gitattributes`** — three things:
  - `* text=auto eol=lf` plus explicit overrides on `*.sh`/`*.fish`
    fixes CRLF drift on Windows/WSL where bash scripts silently
    break with "bad interpreter".
  - `tests/**` `scripts/**` `docs/**` tagged so GitHub Linguist's
    front-page language stat reflects runtime code, not test +
    config + doc bulk. Lockfile marked `linguist-generated`.
  - `export-ignore` on `.github/`, `.husky/`, `tests/`, config
    files so `git archive` (the engine behind GitHub's
    "Download ZIP") emits a lean tarball. Doesn't affect the npm
    tarball — that's controlled by `package.json files`.
- **README "Security" section** — was no top-level pointer to
  `SECURITY.md` from the front page. Added one with the
  reporting channels, SLA, and an inline summary of in-repo
  hardening. SECURITY.md hardening list updated in lockstep with
  the constant-time API-key comparison entry so the two pages
  agree.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1 adapted
  for this project with `conduct@artagon.dev` channel + 3-day
  ack / 14-day response SLA. Linked from CONTRIBUTING.md.
- **README binary list fix** — Install section claimed two bins
  ship on PATH but `package.json` has had three since the
  cost-tracking work landed. Added the `artagon-stats` one-liner.
- **`docs/openai-facade.md`** — comprehensive HTTP facade
  reference (251 lines): endpoint table with auth-required column,
  backend routing pattern → backend map, SSE wire format with
  finish_reason mapping, error response taxonomy, auth + CORS
  configuration matrix, library vs CLI usage, limits.
- **`scripts/generate-homebrew-formula.mjs` test suite** (4 cases)
  covering `--help` output, unknown flag rejection, missing-value
  rejection, and a fetch-failure path. Used `mkdtempSync` for
  temp paths (CodeQL hygiene).

### Documentation

- **README badges** — replaced the stale hardcoded
  `tests-587-passing` badge (drifts every commit, we're at 700+ now)
  with two live GitHub Actions badges that auto-update from `main`:
  CI test.yml + CodeQL. Both link to the workflow run lists.

- **`docs/homebrew-tap.md`** updated for the `--version` →
  `--pkg-version` rename in 6bc5514 (commander auto-injects
  `--version` for package version, so the script's flag had to
  rename).

### Tests

- **`scripts/generate-homebrew-formula` smoke tests** (4 cases). The
  generator was refactored to commander in 6bc5514 but had no test
  coverage in this repo. Covers --help layout + --pkg-version
  missing-value rejection + unknown-flag rejection + the fetch-failure
  exit-1 path (validated against an impossible version string;
  network-free).

### Documentation

- **`CODE_OF_CONDUCT.md`** adapted from Contributor Covenant 2.1 with
  project-specific reporting channels (`conduct@artagon.dev`, separate
  from `SECURITY.md`'s vuln channel). `CONTRIBUTING.md` gains a
  cross-reference section so contributors don't conflate the two.
  Closes the last missing community-standard file in the repo root.

- **OpenAI facade docstring** moved SSE streaming from "Not supported
  (yet)" to "What IS supported"; the streaming surface has been live
  with AbortController threading + socket guards for several commits.

### Added

- **Rebrand to `artagon-agent-cli-plugin`** (was `gemini-plugin-cc`).
  Owner Artagon & Giedrius Trumpickas. Repo at
  `github.com/artagon/artagon-agent-cli-plugin`. Scoped install paths
  via npm + npx + brew documented in `docs/INSTALL.md`. Distributable
  bundle is signed: npm provenance via OIDC + Sigstore, CycloneDX
  SBOM (JSON + XML) attached as a release artifact, Build Provenance
  attestation. Workflows pinned to 40-char SHA action references per
  security audit; `@cyclonedx/cyclonedx-npm@2.1.0` pinned via
  `pnpm-lock.yaml` integrity SHA-512 (replacing unpinned `npx` in the
  publish job that holds NPM_TOKEN).
- **OpenAI Chat Completions HTTP facade** (`lib/server/openai-facade.mjs`,
  `bin/artagon-openai-server`). Spins up a local `/v1/chat/completions`,
  `/v1/models`, `/health` endpoint that routes to the appropriate
  backend (Claude / Codex / Gemini) via `runStatelessTurn` under the
  hood. SSE streaming (`stream: true`) with proper AbortController
  threading: client disconnect SIGTERMs the child; every `sendChunk`
  is guarded against destroyed sockets. `/v1/models` discovers per-
  backend canonical model ids + aliases via
  `lib/backends/discover-models.mjs`. Model resolution accepts both
  bare names ("claude-opus-4-5") and `<backend>:<model>` syntax.
- **`/<plugin>:stats` and `/<plugin>:budget` slash commands** across
  all three plugins. `/stats` prints global + per-backend turn / token
  / wall-clock totals plus the 5 most recent turns by default;
  `--json`/`--since`/`--until`/`--recent N` flags. `/budget`
  compares aggregate usage against a soft budget; supports both
  token mode (`--limit` or `$ARTAGON_BUDGET_TOKENS`) and USD mode
  (`--limit-usd` or `$ARTAGON_BUDGET_USD`); always exit 0
  (observability, not gating); `--json` exposes both `{tokens, usd}`
  totals for downstream gating tooling.
- **Cost USD pricing layer** (`lib/cost/pricing.mjs`). Per-backend ×
  per-model rate table (Sonnet/Opus/Haiku, GPT-5/o-series, Gemini
  Pro/Flash) keyed by longest-prefix substring match against the
  recorded model id. `estimateUsd(backend, model, usage)` with
  defensive coercion (NaN → 0 so a malformed log row can't poison
  the global total). Override the table at runtime via
  `$ARTAGON_PRICING_OVERRIDE` (JSON) — useful when vendor pricing
  changes between releases. `summarizeCostRecords` / `bin/artagon-stats`
  / `formatCostSummaryText` now surface "Estimated cost: $X.XX"
  alongside tokens, both globally and per-backend.
- **Model id capture in cost records.** `TurnResult.model` and
  `SessionUpdate.model` thread through stream-runner + all 3
  translators (claude `message.model`, codex top-level / message,
  gemini `model`/`modelVersion`/`model_version`); runners pass it
  to `appendCostRecord`. `CostRecord.model` is now part of the JSONL
  schema. The pricing layer hits per-model rates instead of falling
  back to per-backend defaults — Opus turns are now correctly priced
  5× Sonnet via the per-model rate table.
- **`bin/artagon-stats` CLI** — shell-side aggregator for the cost
  log. `--json` / `--since` / `--until` / `--recent N` /
  `--version` / `--help`.
- **Cost recorder** (`lib/cost/recorder.mjs`) appends one JSONL row
  per turn under `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl`
  (or `$ARTAGON_COST_LOG` override). Schema:
  `{timestamp, backend, model?, sessionId?, promptChars, usage,
durationMs, reason, ok}`. Best-effort: failures warn once on
  stderr and silently proceed; cost recording must never block a
  turn. `lib/cost/aggregate.mjs` reads + summarizes; pure-ish
  functions data-in/data-out for testability.
- **Dependabot, CodeQL, issue/PR templates** — weekly npm + GitHub
  Actions update PRs (grouped, labeled), CodeQL javascript-typescript
  scan workflow, three issue forms (bug / feature / security) with
  labels, structured PR template with backend coverage matrix,
  8 GitHub labels created via `gh label`.

### Changed

- **PID-reuse hardening on the orphan-runner reaper.** Each pid file
  now stores the OS-reported start time of the child captured at
  register (`childStartedAtOs`), and `checkOrphanedRunners()` requires
  a match before classifying as orphan. PID-mismatch (recycled to
  unrelated process) → classified `stale` (unlink only, never SIGKILL).
  The reap pass re-verifies once more at the moment of `process.kill`
  to close the classify→signal race. New cross-platform
  `readProcStartTime(pid)`: `ps -o lstart=` on POSIX,
  PowerShell `Get-CimInstance Win32_Process` on Windows (avoiding
  deprecated `wmic`).
- **OpenAI facade SSE abort propagation.** Threads
  `AbortController.signal` through dispatch, listens on `res "error"`,
  guards every `sendChunk` against destroyed sockets — was missing
  before; client disconnect didn't kill the runner subprocess.
- **`normalizeUsage` defensive shape detection.** Each backend's
  bare usage shape (claude/codex `input_tokens`, gemini
  `promptTokenCount`, openai `prompt_tokens`) is now detected
  directly; only the wrapper `{usage: {...}}` shape falls back to
  the middleware extractor. Was 0-tokenizing every claude/codex
  turn before this fix.

- **Multi-plugin scaffold** (cross-pollination model). New
  `plugins/claude/` (installed in Claude Code, drives codex + gemini)
  and `plugins/codex/` (installed in Codex CLI, drives gemini + claude)
  alongside the existing legacy `plugins/gemini/`. Each plugin has
  byte-equivalent `.claude-plugin/` and `.codex-plugin/` manifests, a
  `commands/` dir with cross-driving slash commands (`/codex:prompt`,
  `/claude:prompt`, `/gemini:prompt`), and a `scripts/` dir with entry
  points calling `runStatelessTurn(BACKEND_NAMES.<OTHER>, options)`.
  12 structural tests verify manifest shape, byte-equivalence,
  plugin-slug-matches-name, and the cross-pollination invariant (no
  plugin script references its own host backend).
- **Gemini stateless runner** (`lib/runners/gemini-print.mjs` +
  `lib/translate/gemini-stream.mjs`). Spawns `gemini -p <prompt> -o
stream-json` for one-shot invocations that bypass ACP mode. The
  translator handles JSON-RPC envelope unwrap + bare-event passthrough
  - `type`-vs-`sessionUpdate` field tolerance + non-ACP kinds (e.g.
    `file_change`). Completes the cross-backend stateless trio:
    `runStatelessTurn(BACKEND_NAMES.GEMINI, ...)` no longer rejects.
    17 translator unit tests + dispatcher integration test.
- **Stateless runner dispatcher** (`lib/runners/dispatch.mjs`) —
  `runStatelessTurn(backendName, options)` routes to the matching
  runner. Switch-statement, not a registry; explicit cases for the
  three backends + actionable error for unknown names. Tests pin the
  mapping + that runner-side failures (spawn ENOENT, abort, etc.)
  bubble through the dispatcher unchanged.
- **`timeoutMs` defensive bound** on all three runners. SIGTERMs the
  child + rejects with `Error("run<X>: timed out after Nms")` when
  the timer fires. Distinct from `signal` (caller-driven); both can
  be set, whichever fires first wins. `settle()` clears the timer on
  every resolution path so happy-path runs don't keep the event loop
  alive.
- **Orphan-runner detection** (`lib/runners/orphan-check.mjs`).
  Per-process pid files at `<tmp>/<runner>-agent-<8hex>.pid` (per
  user spec) — `$ACP_RUNNER_PID_DIR` overrides; default `os.tmpdir()`.
  JSON body `{childPid, parentPid, runner, command, args, startedAt}`.
  `checkOrphanedRunners({reap, maxAgeMs})` classifies entries as stale
  (child PID gone) or orphaned (alive but parent dead OR older than
  maxAgeMs); `reap: true` SIGKILLs orphans + cleans pid files. All
  three runners register on spawn + deregister on settle.
- **Backend-name enum** (`lib/backends/names.mjs`) — frozen
  `BACKEND_NAMES` object + `BackendName` typedef + `ALL_BACKEND_NAMES`
  iterable + `isBackendName(value)` type guard. Single source of
  truth replacing scattered `"claude"`/`"codex"`/`"gemini"` string
  literals across runners, dispatcher, orphan-check.
- **Stateless runners** — `runClaudePrint` (`lib/runners/claude-print.mjs`)
  and `runCodexExec` (`lib/runners/codex-exec.mjs`). One-shot CLI
  invocations that bypass ACP mode entirely: spawn → stream → translate
  → TurnResult. `runClaudePrint` is currently the **only** runnable
  Claude path (Claude CLI lacks ACP). Both runners support `cwd`/`env`,
  per-invocation knobs (`model`, `effort`, `permissionMode`, etc.),
  AbortSignal cancellation (SIGTERM + reject), and exit-code-aware error
  rejection (`{exitCode, stderr}` shape). 20 integration tests using
  `node -e <script>` synthetic fakes (no real CLI dependency in CI).
- **Stream-json translators** — pure-function event mappers that turn
  each backend's `--json`/`stream-json` output into ACP `session/update`
  notifications. `lib/translate/codex-stream.mjs` handles `item.created`
  / `exec_command.*` / `turn.completed`; `lib/translate/claude-stream.mjs`
  handles `assistant` / `user` / `result` / `system` events with
  multi-block support. 48 unit tests pin every documented event shape
  - drift signal (null on unknown types).
- **Stream-runner helper** (`lib/translate/stream-runner.mjs`) —
  `consumeStreamJson(stdout, translator)` reads line-delimited JSON
  events from any Readable, runs them through a caller-supplied
  translator (single update, array of updates, or null), and
  accumulates a `TurnResult` (text, thoughtText, toolCalls,
  toolResults, usage, reason). Resolves on `turn_completed` or stdout
  EOF, whichever first. 9 tests with PassThrough streams.
- **Conformance suite expanded** — `runConformanceSuite` now runs
  against three concrete factory shapes: MockBackend (in-memory),
  `geminiBackend.transports.cli` (mock binary), and
  `codexBackend.transports.cli` (mock binary). Adding a new backend's
  cli factory is one line: `runConformanceSuite(name, () => factory(...))`.
- **`docs/observability.md`** — entry-point doc for the logger /
  wire-log / tracing trio. Env contracts, redaction posture, OTel
  lazy-load rationale, end-to-end env-cocktail example.
- **`docs/runners.md`** — entry-point doc for `runClaudePrint` +
  `runCodexExec`. Coverage matrix, anatomy diagram, options reference
  per runner, lifecycle table, "when to use" decision table.
- **`STATUS.md` markers** at three obsolete OpenSpec change roots
  (`add-codex-sdk-backend`, `add-claude-sdk-adapter`,
  `add-app-server-transport-and-marketplace-split`) record the
  CLI-only pivot's effect on each. `docs/agent-cli-design.md` prepended
  with a HISTORICAL banner pointing at those markers.
- **`lib/` parallel transport layer** (`acp/`, `transport/`, `backends/`,
  `middleware/`, `state/`, `test-utils/` plus root-level `logger`,
  `wire-log`, `tracing`, `feature-flags`). Adds an AcpSession contract,
  CliTransport / BrokerSocketTransport conforming to it, three backends
  (`gemini`, `codex`, `claude`) declaring modelAliases + transports +
  setupHints, six middlewares (redaction-first composer, audit, cost,
  retry, fallback, content-addressed cache), state v1→v2 field-additive
  migrator, and a `runConformanceSuite(name, factory)` executable contract.
- **Pure-function CLI argv builders** — `buildGeminiArgs`,
  `buildCodexArgs`, `buildClaudeArgs` codify each backend's
  `--help`-derived flag taxonomy with explicit validation (no silent
  fallbacks). 48 unit tests across the three pin argv emission per
  flag, mutual-exclusion rules, and required-with-print constraints.
- **`launchOptions` + `disableBroker` plumbing** through
  `runAcpPrompt`, `runAcpReview`, and `runAcpAdversarialReview`. End
  users can now reach `--yolo`, `--worktree`, `--policy`, `--sandbox`,
  `--include-directories`, etc. via the runtime entry points; the
  spawn factory honors `cwd`/`env` from outer args (cannot be
  overridden by stuffed launchOptions).
- **Subpath imports** — `package.json` `imports` map exposes
  `#lib/*`. All consumers under `plugins/`, `tests/`, and the lib
  itself import via `#lib/...` instead of deep relative paths.
- **`docs/cli-options-research.md`** — empirical reference from
  `--help` of installed `gemini`/`codex`/`claude` covering session
  passing, resume, stateless, and output-format flags.
- **Wire log** (`ACP_WIRE_LOG=/path.jsonl`) records every JSON-RPC
  frame both directions in a format directly consumable by
  `lib/test-utils/fixture-replayer.mjs`.
- **Dual-host install** (Claude Code + Codex CLI). Same plugin source tree
  installs into both `/plugin install gemini@google-gemini` (Claude Code)
  and `codex plugin marketplace add` (Codex CLI). New `.codex-plugin/plugin.json`
  (canonical Codex manifest), `.agents/plugins/marketplace.json` (Codex-shaped
  marketplace descriptor), `agents/openai.yaml` (Codex implicit-invocation
  interface), root `SKILL.md` (Codex skill discovery), `docs/INSTALL.md`
  (cross-host install recipes).
- **`tests/install.test.mjs`** — install-readiness contract tests under both
  Claude and Codex env shapes. Validates marketplace descriptors with
  per-host shape enforcement (Codex object form `{source: "local", path: …}`,
  Claude string form `"./…"`) so a host regressing to the wrong shape is
  caught before merge.
- **`tests/broker-lifecycle.test.mjs`** — coverage for `ensureBrokerSession`
  decision tree (live endpoint reuse, dead endpoint teardown, no-prior-session
  spawn). Pins the round-1 swarm fix that folded staleness check INTO
  `ensureBrokerSession` for race-free single-probe-per-decision behavior.
- **`tests/stop-review-gate.test.mjs`** — execution coverage for the
  stop-review-gate hook's failure semantics: fail-CLOSED on non-zero gemini
  exit, fail-OPEN on ENOENT, and the success-path skip-reason surfacing
  via `logNote(review.reason)` for unknown-format Gemini output.
- **`tests/mocks/gemini-mock.mjs`** — Zed Industries-style ACP mock binary
  for hermetic CI runs. Real executable speaking JSON-RPC over stdio,
  shadows `gemini` on PATH so `getGeminiAuthStatus` doesn't hang on the
  real `@google/gemini-cli`'s OAuth probe in environments without network
  reach to Google's auth endpoints.
- **`plugins/gemini/scripts/lib/review-gate-verdict.mjs`** — single source
  of truth for the `ALLOW:` / `BLOCK:` wire-contract tokens between
  Gemini's response and the parser. Frozen `VERDICT` const, JSDoc-typed
  `parseVerdict` pure function. The prompt template at
  `plugins/gemini/prompts/stop-review-gate.md` remains the source of truth
  for what Gemini emits; this module is the source of truth for how the
  parser interprets it.

### Changed

- **CLI-only architecture** — backends launch their CLI binary in ACP
  mode (`gemini --acp` / `codex acp`); SDK and HTTP/SSE transports
  were retired. Three `STATUS.md` markers under `openspec/changes/`
  flag the now-obsolete proposals (`add-codex-sdk-backend`,
  `add-claude-sdk-adapter`) and the partially-obsolete
  `add-app-server-transport-and-marketplace-split`.
- **Legacy `plugins/gemini/scripts/lib/acp-client.mjs` removed**
  (~454 LOC). All ACP call sites in `plugins/gemini/scripts/lib/gemini.mjs`
  now use the v2 transport layer with broker fallback semantics
  preserved (`connectGeminiAcpV2` helper). Constants
  (`BROKER_BUSY_RPC_CODE`, `BROKER_ENDPOINT_ENV`, `ACP_MAX_LINE_BUFFER`)
  moved to `plugins/gemini/scripts/lib/broker-constants.mjs`.
- **`docs/architecture.md` rewritten** for the post-pivot reality —
  removed legacy/v2 split diagram, added Middleware layer, documented
  `worker_missing` reject semantics + redaction-first invariant +
  subpath imports + no-silent-fallbacks posture.
- **`docs/backends/{gemini,codex,claude}.md` rewritten** for the
  CLI-only world. New `docs/backends/gemini.md` (was missing); codex
  and claude docs no longer advertise SDK transports.
- **Stop-review-gate hook** (`plugins/gemini/scripts/stop-review-gate-hook.mjs`)
  fails CLOSED on any non-ENOENT gemini failure (non-zero exit, signal kill,
  OOM). Was: fail-OPEN on every error. ENOENT (binary not on hook's
  inherited PATH) keeps fail-OPEN to avoid locking the user into review-
  failed loops on Finder-launched GUI apps. The success-path `review.reason`
  (skip / format-mismatch) is now logged via `logNote()` so the user sees
  WHY the gate was skipped; previously dropped silently. (Resolves Copilot
  inline comments `3171646271` and `3171646302` on artagon PR #1.)
- **`plugins/gemini/scripts/lib/plugin-info.mjs`** removes `package.json`
  from the manifest fallback chain. The `package.json.name` (`gemini-plugin-cc`,
  npm package name) drifted from the plugin manifests' `name` (`gemini`),
  silently changing ACP `clientInfo.name` and `serverInfo.name` for any
  consumer matching on identity.
- **Host detection** uses `CLAUDE_ENV_FILE` (Claude Code's session-hook
  signal) with `statSync().isFile()` validation, rather than just
  `CLAUDE_PLUGIN_DATA`. Prevents a user-exported `CLAUDE_PLUGIN_DATA`
  in shell rc from pulling Codex into Claude's state tree.
- **`.github/workflows/install.yml`** matrix is Linux-only
  (`ubuntu-latest × node-{20,22}`). Was: `{ubuntu, macos} × node-{20,22}`.
  GitHub-hosted macOS runners bill at ~10× Linux per-minute; Linux runs
  catch the vast majority of platform regressions and macOS-specific
  behaviors are unit-tested via `os.tmpdir()` + `node:path` already.

### Fixed

- **AcpClient hangs on spawn failure** — when transport health
  transitions to `worker_missing` (child died, ENOENT, etc.),
  pending requests now reject with a clear error instead of waiting
  for the caller's timeout. Caught by the `getGeminiAuthStatus`
  spawn-failure test which timed out at 30s before the fix.
- **`agents/openai.yaml:12`** — stale `.codex/INSTALL.md` reference
  replaced with `docs/INSTALL.md`. (Resolves Copilot inline comment
  `3171646292` on artagon PR #1.)
- **`tests/install.test.mjs`** — marketplace test now validates BOTH
  `.agents/plugins/marketplace.json` (Codex) AND
  `.claude-plugin/marketplace.json` (Claude) with per-host shape enforcement
  - cross-host name agreement. (Resolves Copilot inline comment
    `3171646282` on artagon PR #1.)
- **`broker-lifecycle.mjs:reapStaleBroker`** marked `@deprecated` —
  no longer called from runtime as of round-1 fix-batch which folded
  staleness + liveness into `ensureBrokerSession` for race-free single-
  probe behavior. Retained for `broker-reaper.test.mjs` compatibility;
  slated for removal in a follow-up cleanup PR.

## [1.0.1] - 2026-04-18

### Added

- **Streamed ACP output and thought chunks** ([#20], closes [#15]). `runAcpPrompt` now distinguishes `agent_thought_chunk` from `agent_message_chunk` end-to-end, accumulates a separate `thoughtText` return field, and records a dedicated `model_thought_chunk` event (char counts only — raw prose is never persisted).
- **`--stream-output` flag** for `/gemini:rescue` and `/gemini:review` ([#20]). Live stderr forwarding of model chunks and thoughts (with a `thought:` prefix). Default mode shows compact progress markers (`[session]`, `[tool]`, `.` per chunk, `[thinking]`, `[file]`, `[done] stats`). EPIPE-safe; auto-suppressed in `--json` mode unless explicitly opted in.
- **`--thinking <off|low|medium|high>` flag** ([#20]). T-shirt-sized reasoning budgets that resolve per model family (Gemini 3 / 3.1 `thinkingLevel`; Gemini 2.5 `thinkingBudget` with off→low clamping). Replaces the non-functional `--thinking-budget <n>`. Emits a one-shot stderr warning noting that upstream Gemini CLI 0.38.x delivers thinking via persistent `settings.json`, not per-invocation.
- **Gemini job observability** ([#16], closes [#14]). New `lib/job-observability.mjs` helper with bounded event log (50 events/job, 500-char diagnostic cap, ANSI/CSI/OSC/DCS stripping). Derived health fields expose liveness, progress, rate-limit, auth-block, broker, and worker states.
- **`/gemini:status` event tail** ([#16], [#20]). `renderSingleJobStatus` shows the last 5 sanitized events with human-readable `Ns ago` timestamps, rollup counters (`chunks/thoughts/tools/files`), and graceful fallback when the event log is absent.
- **Broker trust boundary** ([#16]). Distinct `broker/diagnostic` JSON-RPC method prevents compromised children from forging broker notifications.
- **CI test workflow** ([#9]). `.github/workflows/test.yml` runs `npm test` on every PR. PR cleanup workflow added.
- **Docs-agreement test suite** ([#20]). `tests/docs-agreement.test.mjs` asserts `--thinking` and `--stream-output` stay documented across `README.md`, `rescue.md`, and `review.md`, and that the stale `--thinking-budget <number>` form is gone.

### Changed

- **Model mapping and selection guidance** ([#8], closes [#7]). Updated default model aliases and selection guidance in `/gemini:rescue` and `/gemini:review` for clearer routing between Pro, Flash, and Flash-Lite.
- **ACP protocol type definitions** ([#20]). `lib/acp-protocol.d.ts` replaces the stale `AcpNotification` union (`progress`/`toolCall`/`fileChange`/`error` — none matched the real runtime) with `SessionUpdateNotification` modeling `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `file_change`, plus `broker/diagnostic`.
- **Documentation**. `README.md` adds a "Live Progress & Thinking Levels" section; `plugins/gemini/commands/rescue.md`, `plugins/gemini/commands/review.md`, and `plugins/gemini/agents/gemini-rescue.md` refreshed with new `argument-hint` and runtime-flag lists.

### Fixed

- **Root workspace path containment** ([#13], closes [#6]). Path containment check no longer false-negatives at filesystem root (`/`).
- **ACP broker socket permissions (TOCTOU)** ([#12], closes [#5]). Socket permissions now set atomically to eliminate the time-of-check-to-time-of-use race.
- **ACP protocol type map** ([#10], closes [#3]). Aligned the type definitions with the runtime method name that was actually being dispatched.
- **`--scope` flag validation** ([#9], closes [#2]). Invalid values now fail fast with a clear error instead of silently falling back to `working-tree`.
- **PID-reuse false positives** ([#16]). `defaultIsProcessAlive` now treats `EPERM` as a dead worker to avoid reading a stranger process as alive after a PID is recycled.

### Removed

- **Dead code in `stop-review-gate-hook`** ([#11], closes [#4]). Unused imports and branches pruned.
- **`--thinking-budget <number>` flag** ([#20]). Replaced by `--thinking <off|low|medium|high>`; the numeric form was non-functional.

### Security

- **Broker passthrough forgery (HIGH)** ([#16]). Broker no longer forwards arbitrary child notifications as broker-origin diagnostics.
- **Diagnostic sanitization** ([#16]). All broker and worker diagnostics strip ANSI/CSI/OSC/DCS sequences and enforce a 500-char cap before entering the event log or the compact job index.
- **Privacy-preserving observability** ([#16], [#20]). Compact job-index and progress events use an explicit allow-list. Raw prompts, raw model prose, and raw thought prose never enter job files, status output, or logs — only char counts.

### Stats

- 51 files changed, +4547 / -263 lines across 8 merged PRs.
- Test suite: 172 / 172 passing.

[1.0.1]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/compare/v1.0.0...v1.0.1
[#20]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/20
[#16]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/16
[#15]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/15
[#14]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/14
[#13]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/13
[#12]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/12
[#11]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/11
[#10]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/10
[#9]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/9
[#8]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/8
[#7]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/7
[#6]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/6
[#5]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/5
[#4]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/4
[#3]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/3
[#2]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/2
