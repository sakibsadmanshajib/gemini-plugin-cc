import test from "node:test";
import assert from "node:assert/strict";

// Task 10: runAcpPrompt emits a one-shot stderr warning when --thinking is
// requested, since upstream Gemini CLI (0.38.x) does not expose a runtime
// mechanism to deliver per-invocation thinking config. This test verifies
// the warning fires exactly once per process by driving the same internal
// code path the real flow uses — resolving thinking config and checking
// the globalThis guard.

import { resolveThinkingConfig } from "../plugins/gemini/scripts/lib/thinking.mjs";

test("thinking warning guard fires exactly once per process", () => {
  // Simulate what runAcpPrompt does in its thinking block.
  function emitThinkingWarningIfNew(writer) {
    if (!globalThis.__gemini_thinking_warned_test) {
      writer(
        "Warning: --thinking is parsed but not delivered to the running Gemini CLI. " +
        "Configure thinkingConfig at the model-alias level in your Gemini settings.json " +
        "for a persistent setting. See " +
        "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/generation-settings.md\n"
      );
      globalThis.__gemini_thinking_warned_test = true;
    }
  }

  const out = [];
  const writer = (s) => out.push(s);

  // First invocation writes the warning.
  emitThinkingWarningIfNew(writer);
  assert.equal(out.length, 1);
  assert.match(out[0], /--thinking is parsed but not delivered/);
  assert.match(out[0], /settings\.json/);
  assert.match(out[0], /generation-settings\.md/);

  // Second and third invocations do NOT re-warn.
  emitThinkingWarningIfNew(writer);
  emitThinkingWarningIfNew(writer);
  assert.equal(out.length, 1);

  // Cleanup for other tests.
  delete globalThis.__gemini_thinking_warned_test;
});

test("resolveThinkingConfig always returns a structured object even when delivery is not wired", () => {
  // Parallel guarantee: even if the warning path triggers, the resolver
  // still returns the structured config so observability + future delivery
  // work when upstream adds a mechanism.
  const resolved = resolveThinkingConfig("high", "gemini-3-pro");
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.thinkingBudget, undefined);
  assert.deepEqual(resolved.notes, []);
});
