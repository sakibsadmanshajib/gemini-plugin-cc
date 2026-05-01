# Tasks: add-app-server-transport-and-marketplace-split

## 1. Workspace activation

- [ ] T1.1 — Update `pnpm-workspace.yaml` to declare:
  ```
  packages:
    - 'lib'
    - 'plugins/*'
  ```
- [ ] T1.2 — Move existing `lib/` content into `lib/src/`; create
  `lib/package.json` with name `@artagon/acp-plugin-lib`, version
  `0.1.0`, type `module`, exports map
- [ ] T1.3 — Define exports map for `@artagon/acp-plugin-lib`:
  ```
  "./acp/*": "./src/acp/*.mjs"
  "./transport/*": "./src/transport/*.mjs"
  "./backends/*": "./src/backends/*.mjs"
  ...
  ```
- [ ] T1.4 — Verify `pnpm install` symlinks the workspace package
- [ ] T1.5 — Update Turborepo config (now warranted) for cross-package
  task graph

## 2. Plugin shells

- [ ] T2.1 — Create `plugins/gemini/` shell with:
  - `.claude-plugin/plugin.json` (name `gemini`)
  - `commands/{review,rescue,adversarial-review,status,result,cancel,setup}.md`
  - `agents/gemini-rescue.md`
  - `scripts/companion.mjs` entry point depending on
    `@artagon/acp-plugin-lib` and `@artagon/acp-plugin-lib/backends/gemini`
- [ ] T2.2 — Migrate existing slash command behavior into Gemini shell
  unchanged
- [ ] T2.3 — Create `plugins/codex/` shell mirroring Gemini, importing
  `codexBackend`
- [ ] T2.4 — Create `plugins/claude/` shell mirroring Gemini, importing
  `claudeBackend`
- [ ] T2.5 — Each shell's `package.json` declares `workspace:*` dep on
  `@artagon/acp-plugin-lib`

## 3. HttpTransport

- [ ] T3.1 — Create `lib/src/transport/http.mjs`:
  ```
  createHttpTransport({ command, args, port, env, healthCheckInterval })
    → AcpSession
  ```
- [ ] T3.2 — Subprocess lifecycle: spawn long-running App Server,
  detect ready state, hold connection
- [ ] T3.3 — Use `undici` as HTTP client (cleaner cancellation than
  node-fetch)
- [ ] T3.4 — SSE event stream parsing
- [ ] T3.5 — Port allocation: `port: 0` requests OS-assigned port;
  explicit port honored if available, error if conflict
- [ ] T3.6 — Health tracking compatible with existing labels
- [ ] T3.7 — Conformance test against fake App Server

## 4. App Server translator

- [ ] T4.1 — Create `lib/src/backends/codex/app-server-translator.mjs`
- [ ] T4.2 — Translate App Server-specific event shapes (different from
  SDK shapes) → ACP `session/update`
- [ ] T4.3 — Snapshot tests with recorded fixtures
- [ ] T4.4 — Document translator contract in `docs/translator-guide.md`

## 5. Codex backend extended

- [ ] T5.1 — Add `http` to `codexBackend.transports`:
  ```
  http: (config) => createHttpTransport({ command: 'codex', args: ['--app-server', '--port', String(config.port ?? 0)], translator: translateAppServerEvent })
  ```
- [ ] T5.2 — Document transport selection in
  `docs/backends/codex.md`: when to use SDK vs CLI vs HTTP
- [ ] T5.3 — Conformance: all three Codex transports pass conformance

## 6. Marketplace publication

- [ ] T6.1 — Create root `.claude-plugin/marketplace.json`:
  ```
  {
    "name": "artagon-acp",
    "plugins": [
      { "name": "gemini", "source": { "type": "local", "path": "./plugins/gemini" } },
      { "name": "codex", "source": { "type": "local", "path": "./plugins/codex" } },
      { "name": "claude", "source": { "type": "local", "path": "./plugins/claude" } }
    ]
  }
  ```
- [ ] T6.2 — Verify each plugin installs via `claude plugin install <backend>@artagon-acp`
- [ ] T6.3 — Backwards-compat: ensure old `gemini-plugin-cc` install URL
  still works (per Phase 0.2 verification)

## 7. v1/v2 flag flip

- [ ] T7.1 — Confirm all v2 features behind `ACP_PLUGIN_VERSION=v2`
  are stable
- [ ] T7.2 — Update default in `lib/src/feature-flags.mjs`: default
  becomes `v2`
- [ ] T7.3 — Add 30-day deprecation log: `v1` mode emits a one-time
  warning per session: "v1 mode will be removed on <DATE>; please
  test v2 and report issues"
- [ ] T7.4 — Document v1 removal date in `docs/v1-deprecation.md`

## 8. Rollback procedure

- [ ] T8.1 — Document rollback in `docs/v2-rollback-procedure.md`:
  step-by-step revert of the flag-flip PR, what users need to do
- [ ] T8.2 — Dry-run rollback in a staging environment before
  production flip
- [ ] T8.3 — Test: ensure state files written under v2 are readable by
  v1 (or v1 ignores them gracefully); document any one-way migrations

## 9. Documentation

- [ ] T9.1 — `docs/installation.md` — install each plugin, transport
  selection, auth setup per backend
- [ ] T9.2 — `docs/migration-from-gemini-plugin-cc.md` — for existing
  Gemini users
- [ ] T9.3 — `docs/backends/codex.md` — transport selection guide
- [ ] T9.4 — `docs/v1-deprecation.md` — timeline and removal date
- [ ] T9.5 — Top-level README rewritten for multi-plugin shape

## 10. Verification

- [ ] T10.1 — All conformance tests pass for all backends and transports
- [ ] T10.2 — All three plugins installable via marketplace
- [ ] T10.3 — Backwards-compat install URL still works
- [ ] T10.4 — Cross-backend smoke test: install all three, run a smoke
  task in each
- [ ] T10.5 — Rollback dry-run completed and documented
- [ ] T10.6 — Mutation score on `lib/src/transport/http.mjs` ≥ 70%
- [ ] T10.7 — At least 3 PRs reviewed via `/codex:adversarial-review`
  (more for this stage-gating change)

## Acceptance

- [ ] All tasks complete
- [ ] CI green across all backends
- [ ] All three plugins installable independently
- [ ] v1/v2 flag flipped to v2 default
- [ ] Rollback procedure tested and documented
- [ ] At least one external user (not the author) successfully installs
  and runs a smoke test on at least two backends
