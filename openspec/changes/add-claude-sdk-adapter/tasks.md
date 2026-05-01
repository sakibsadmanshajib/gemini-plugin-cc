# Tasks: add-claude-sdk-adapter

## 1. Claude Agent SDK installation and pinning

- [ ] T1.1 — Add `@anthropic-ai/claude-agent-sdk` as exact-version
  dependency
- [ ] T1.2 — Startup version assertion (warn on mismatch)
- [ ] T1.3 — Verify auth-file reading: with fixture
  `~/.claude/.credentials.json`, SDK authenticates without explicit key

## 2. Translator

- [ ] T2.1 — Create `lib/backends/claude/translator.mjs`
- [ ] T2.2 — Translate `assistant` messages → `agent_message_chunk`
  notifications
- [ ] T2.3 — Translate `tool_use` blocks → `tool_call` notifications
- [ ] T2.4 — Translate `tool_result` blocks → `tool_result` notifications
- [ ] T2.5 — Translate `result` messages → `session/update` with
  completion marker
- [ ] T2.6 — Translate `system` messages → debug log only (no ACP
  surface)
- [ ] T2.7 — Untranslatable events: log at debug, count for drift
  metric, return null
- [ ] T2.8 — Translation snapshot tests using recorded SDK fixtures
- [ ] T2.9 — Property test: random SDK event → translation → no crash,
  returns either valid ACP shape or null

## 3. Degraded-mode fallback

- [ ] T3.1 — Define "degraded mode" in `docs/backends/claude.md`:
  text streaming preserved; tool calls and rich features fall back to
  log warnings
- [ ] T3.2 — When translator returns null for a category that should
  surface (e.g., tool_call), translator emits a warning log and ACP
  continues with reduced fidelity
- [ ] T3.3 — `degradedMode` counter exposed in metrics; growing count
  triggers tracking issue
- [ ] T3.4 — Test: feed a synthetic "future event type" through the
  translator, verify degraded-mode behavior

## 4. Claude backend declaration

- [ ] T4.1 — Create `lib/backends/claude.mjs`:
  ```
  export const claudeBackend = {
    name: 'claude',
    modelAliases: { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-7', haiku: 'claude-haiku-4-5' },
    transports: {
      sdk: (config) => createSdkTransport({ sdk: createClaudeSdkAdapter(config), translator: translateClaudeEvent })
    },
    defaultTransport: 'sdk',
    setupHints: { authCommand: 'claude /login', configPath: '~/.claude/.credentials.json' }
  }
  ```
- [ ] T4.2 — `createClaudeSdkAdapter(config)` wraps `query()` from
  `@anthropic-ai/claude-agent-sdk` into the `runStreaming({ input, signal })`
  shape that `SdkTransport` expects
- [ ] T4.3 — Claude-specific health interpretation: rate-limit, auth
  failure, context-overflow detection

## 5. Tool call coordination

- [ ] T5.1 — Map Claude `permission_mode` config to backend behavior:
  - `default` → request_permission for each tool call
  - `acceptEdits` → auto-approve file edits, request for others
  - `bypassPermissions` → auto-approve all (for E2E only, never default)
- [ ] T5.2 — Tool call permission round-trip test: SDK requests tool
  use → translator emits `request_permission` → test approves →
  approval propagates to SDK
- [ ] T5.3 — Test: tool call denied → SDK gracefully handles → session
  continues without that tool

## 6. E2E with cost controls

- [ ] T6.1 — Create `e2e-claude.yml` nightly CI lane
- [ ] T6.2 — Use `ANTHROPIC_API_KEY_E2E` secret with provider-side
  spend cap
- [ ] T6.3 — Tests use `claude-haiku-4-5` only
- [ ] T6.4 — Smoke test: session/new, simple prompt, tool call, cancel,
  verify clean shutdown
- [ ] T6.5 — Document E2E policy in `docs/e2e-policy.md`

## 7. Drift detection CI

- [ ] T7.1 — `upstream-drift-claude.yml` nightly cron against latest
  `@anthropic-ai/claude-agent-sdk`
- [ ] T7.2 — Compare translation snapshot tests
- [ ] T7.3 — Track degraded-mode counter from canary runs
- [ ] T7.4 — Post drift summary to tracking issue without failing main CI

## 8. Conformance verification

- [ ] T8.1 — `claudeBackend.transports.sdk(...)` with mocked SDK passes
  conformance
- [ ] T8.2 — Existing Gemini and Codex conformance still passes (no
  regressions)

## 9. Documentation

- [ ] T9.1 — `docs/backends/claude.md` — auth, model aliases,
  permission modes, degraded mode, troubleshooting
- [ ] T9.2 — `docs/architecture.md` updated with three backends
- [ ] T9.3 — `docs/translator-guide.md` — how to write a translator,
  rules for handling unknown events

## 10. Verification

- [ ] T10.1 — All conformance tests pass for all three backends
- [ ] T10.2 — Mutation score on `lib/backends/claude/translator.mjs`
  ≥ 70%
- [ ] T10.3 — E2E nightly green for at least 3 consecutive nights
- [ ] T10.4 — Degraded-mode regression test passes
- [ ] T10.5 — At least 2 PRs reviewed via `/codex:adversarial-review`
- [ ] T10.6 — Cross-validation: Gemini and Codex E2E still green

## Acceptance

- [ ] All tasks complete
- [ ] CI green including new Claude E2E lane
- [ ] Claude backend works in-process with existing Claude auth
- [ ] No regressions in Gemini or Codex backends
- [ ] Degraded-mode fallback documented and tested
