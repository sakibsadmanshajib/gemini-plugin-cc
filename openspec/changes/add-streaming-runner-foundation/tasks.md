# Tasks

## 1. Contract & lifecycle plumbing

- [x] 1.1 Define `StreamingRunner` JSDoc contract in
      `lib/runners/streaming/types.mjs` (start/runTurn/close/health)
- [x] 1.2 Implement `createSupervisor(opts)` in
      `lib/runners/streaming/supervisor.mjs` with lazy start, idle
      reap, bounded restart, idempotent close
- [x] 1.3 Implement `getStreamingRunner(backend, opts)` registry in
      `lib/runners/streaming/registry.mjs` with per-(backend,cwd)
      supervisor cache + `shutdownAllStreamingRunners()` +
      `_resetStreamingRegistryForTest()`
- [x] 1.4 Unit tests for supervisor (16 cases): lazy start, idempotent
      start/close, idle reap, restart-budget, dead-state propagation,
      timer reset on success
- [x] 1.5 Verify `StreamingHealth` enumeration matches the legacy
      gemini broker's labels (so observability is consistent)

## 2. Gemini streaming runner

- [x] 2.1 Implement `createGeminiStreamingRunner(opts)` in
      `lib/runners/streaming/gemini-streaming.mjs` — connect to live
      broker, do `initialize` + `session/new` in start(), reuse
      sessionId for each runTurn
- [x] 2.2 Translator reuse: notification handler delegates to
      `translateGeminiStreamEvent` for parity with `runGeminiViaBroker`
- [x] 2.3 Cost record emits `transport: "acp-server"` so observability
      can distinguish from `transport: "broker"` (per-turn) and
      `transport: "cli"` (cold-start)
- [x] 2.4 Unit tests (15 cases): no-broker rejection, happy-path
      handshake, prompt forwarding, accumulation of
      agent_message_chunk / tool_call notifications, stopReason+usage
      from response, degraded vs dead health labels, onUpdate
      callback, idempotent close, turn timeout

## 3. Dispatcher integration

- [x] 3.1 Add `shouldUseStreaming(options)` predicate (option flag
      OR `ARTAGON_STREAMING=1`, vetoed by `disableStreaming: true`)
- [x] 3.2 Add `runWithStreamingFallback(backend, options)` —
      consults registry, calls runner.runTurn, falls back to direct
      path on null-runner OR error
- [x] 3.3 One-shot warning latch `warnedStreamingFallback` (mirrors
      Phase 0/2 latches) so failure spam is bounded to one stderr line
      per process
- [x] 3.4 `_resetBrokerWarningForTest` resets the new latch too
      (REMOVED in K3 post-Step 5: the broker-fallback machinery and
      all its warning latches no longer exist, so the test helper had
      no behavior to reset and was deleted from `lib/runners/dispatch.mjs`)
- [x] 3.5 Unit tests (10 cases): opt-in routing, env opt-in, veto
      precedence, null-runner silent fall-through, error fallback +
      warning, repeated-failure single-warn, prompt/cwd/model/onUpdate
      forwarding

## 4. Documentation

- [x] 4.1 Cost-record `transport` field documented in
      `lib/cost/recorder.mjs` JSDoc gains `acp-server` value

## 5. Validation

- [x] 5.1 `pnpm typecheck` clean
- [x] 5.2 `pnpm lint` clean
- [x] 5.3 `pnpm vendor:lib:check` clean (or run `pnpm vendor:lib`)
- [x] 5.4 Full test suite passes (target: 882+ passed, +41 from this
      change)
- [x] 5.5 `openspec validate add-streaming-runner-foundation --strict`

## 6. Out of scope (forward references)

- [ ] 6.1 Wire CODEX streaming runner — covered by
      `add-unified-acp-server-with-mcp-aggregation` Phase 1.5
- [ ] 6.2 Wire CLAUDE streaming runner — covered by
      `add-unified-acp-server-with-mcp-aggregation` Phase 1.6 with
      empirical Path A vs Path B determination
- [ ] 6.3 Lift the legacy `gemini --acp` broker out of
      `plugins/gemini/scripts/lib/` so the streaming runner can own
      the subprocess directly — covered by
      `add-unified-acp-server-with-mcp-aggregation` Phase 1.4
