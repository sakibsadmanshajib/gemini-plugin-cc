# Tasks: add-codex-sdk-backend

## 1. SdkTransport base

- [ ] T1.1 — Create `lib/transport/sdk.mjs`:
  ```
  createSdkTransport({ sdk, translator, abortTimeout })
    → AcpSession
  ```
- [ ] T1.2 — Lifecycle: `start` instantiates session via SDK; `prompt`
  invokes streaming run, iterates events, calls translator
- [ ] T1.3 — Cancel via AbortController; abort timeout fallback
- [ ] T1.4 — Error normalization: SDK errors → ACP error shape
- [ ] T1.5 — Health tracking: time since last event, mirror of CLI
  transport semantics
- [ ] T1.6 — Apply conformance test suite to a synthetic SdkTransport
  using a mock SDK

## 2. Codex SDK installation and version pin

- [ ] T2.1 — Add `@openai/codex-sdk` as exact-version dependency
  (`"@openai/codex-sdk": "1.x.y"`, no caret)
- [ ] T2.2 — Add startup assertion: SDK package version matches the
  pinned version; warn if mismatch (allows local dev with newer
  versions)

## 3. Codex translator

- [ ] T3.1 — Create `lib/backends/codex/translator.mjs`:
  - input: Codex SDK event (typed)
  - output: ACP `session/update` notification or null (some events
    are internal-only)
- [ ] T3.2 — Translate `item.created` → `tool_call` or
  `agent_message_chunk` based on item type
- [ ] T3.3 — Translate `turn.completed` → session/update with
  completion marker
- [ ] T3.4 — Translate exec_command_* events → `tool_result`
- [ ] T3.5 — Capture untranslatable events; log at debug, count for
  drift metric
- [ ] T3.6 — Unit tests using recorded SDK event fixtures
- [ ] T3.7 — Snapshot tests for translation tables

## 4. Codex backend declaration

- [ ] T4.1 — Create `lib/backends/codex.mjs`:
  ```
  export const codexBackend = {
    name: 'codex',
    modelAliases: { spark: '...', mini: '...', high: '...' },
    transports: {
      sdk: (config) => createSdkTransport({ sdk: new Codex(...), translator: translateCodexEvent }),
      cli: (config) => createCliTransport({ command: 'codex', args: ['acp'], ... })
    },
    defaultTransport: 'sdk',
    setupHints: { authCommand: 'codex login', configPath: '~/.codex/auth.json' }
  }
  ```
- [ ] T4.2 — Codex-specific health interpretation: rate-limit, auth
  failure detection
- [ ] T4.3 — Document auth flow in `docs/backends/codex.md`

## 5. Auth-file behavior verification

- [ ] T5.1 — Test: with fixture `~/.codex/auth.json`, `new Codex()`
  authenticates without explicit key
- [ ] T5.2 — Test: with explicit `apiKey` config, that key is used
  even if auth.json exists
- [ ] T5.3 — Test: with neither auth.json nor explicit key, first
  request fails with auth error and health is `auth_required`

## 6. E2E with cost controls

- [ ] T6.1 — Create dedicated CI lane `e2e-codex.yml`:
  - runs only on nightly schedule
  - uses `OPENAI_API_KEY_E2E_CODEX` secret with provider-side budget
    cap of $X/month
  - exponential backoff (3 retries) on transient failures
  - tests against `spark` model only
- [ ] T6.2 — E2E smoke test: session/new, simple prompt, verify
  response, cancel, verify clean shutdown
- [ ] T6.3 — Document in `docs/e2e-policy.md`: who has access to the
  E2E API key, budget cap, alert thresholds

## 7. Drift detection CI

- [ ] T7.1 — Create `upstream-drift-codex.yml` nightly cron:
  - install latest `@openai/codex-sdk` (no version pin)
  - run translation snapshot tests
  - compare against pinned version's snapshots
  - on drift, post comment to tracking issue, do not fail main CI
- [ ] T7.2 — Tracking issue template for upstream drift

## 8. Conformance verification

- [ ] T8.1 — `geminiBackend.transports.cli(...)` passes conformance
  (regression check)
- [ ] T8.2 — `codexBackend.transports.sdk(...)` with mocked SDK passes
  conformance
- [ ] T8.3 — `codexBackend.transports.cli(...)` (if Codex CLI ACP mode
  available) passes conformance
- [ ] T8.4 — `MockBackend` still passes (no regressions in conformance
  suite)

## 9. Documentation

- [ ] T9.1 — `docs/backends/codex.md` — auth, transport choice,
  troubleshooting
- [ ] T9.2 — `docs/transport-sdk.md` — how SdkTransport works,
  translator contract, when to use SDK vs CLI
- [ ] T9.3 — `docs/architecture.md` updated with new backend

## 10. Verification

- [ ] T10.1 — All conformance tests pass
- [ ] T10.2 — Mutation score on `lib/transport/sdk.mjs` and
  `lib/backends/codex/translator.mjs` ≥ 70%
- [ ] T10.3 — E2E nightly job green for at least 3 consecutive nights
- [ ] T10.4 — At least 2 PRs reviewed via `/codex:adversarial-review`
- [ ] T10.5 — Cross-validation: Gemini E2E still green (no regressions)

## Acceptance

- [ ] All tasks complete
- [ ] CI green including new Codex E2E lane
- [ ] Codex backend works in-process with existing Codex auth
- [ ] No Gemini regressions
