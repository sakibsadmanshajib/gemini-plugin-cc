import test from "node:test";
import assert from "node:assert/strict";

// Task 10: runAcpPrompt emits a one-shot stderr warning when --thinking is
// requested, since upstream Gemini CLI (0.38.x) does not expose a runtime
// mechanism to deliver per-invocation thinking config. This test verifies
// the warning fires exactly once per process by driving the same internal
// code path the real flow uses — resolving thinking config and checking
// the globalThis guard.

import { __testing as gemini } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { resolveThinkingConfig } from "../plugins/gemini/scripts/lib/thinking.mjs";

test("thinking warning guard fires exactly once per process", () => {
  const out = [];
  const writer = (s) => out.push(s);

  // First invocation writes the warning.
  gemini.resetThinkingWarning();
  gemini.emitThinkingWarningIfNew(writer);
  assert.equal(out.length, 1);
  assert.match(out[0], /--thinking is parsed but not delivered/);
  assert.match(out[0], /settings\.json/);
  assert.match(out[0], /generation-settings\.md/);

  // Second and third invocations do NOT re-warn.
  gemini.emitThinkingWarningIfNew(writer);
  gemini.emitThinkingWarningIfNew(writer);
  assert.equal(out.length, 1);

  // Cleanup for other tests.
  gemini.resetThinkingWarning();
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
