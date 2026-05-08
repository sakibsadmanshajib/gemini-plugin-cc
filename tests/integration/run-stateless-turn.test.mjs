/**
 * Tests for the runStatelessTurn dispatcher.
 *
 * Maps:
 *   - "claude" → runClaudePrint (verified via synthetic node -e fake)
 *   - "codex"  → runCodexExec   (verified via synthetic node -e fake)
 *   - "gemini" → rejects with actionable error pointing at runAcpPrompt
 *   - unknown  → rejects with "unknown backend" message
 */

import { expect, test } from "vitest";

import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

/**
 * @param {any[]} events
 * @returns {string[]}
 */
function fakeStreamArgs(events) {
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return ["-e", `process.stdout.write(${JSON.stringify(payload)});`];
}

test("dispatch claude → runClaudePrint produces TurnResult from claude events", async () => {
  const turn = await runStatelessTurn("claude", {
    prompt: "ignored",
    command: process.execPath,
    _argsOverride: fakeStreamArgs([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "claude says hi" }] }
      },
      { type: "result", subtype: "success" }
    ])
  });
  // Claude translator emits agent_message_chunk for text blocks.
  expect(turn.text).toBe("claude says hi");
  expect(turn.reason).toBe("success");
});

test("dispatch codex → runCodexExec produces TurnResult from codex events", async () => {
  const turn = await runStatelessTurn("codex", {
    prompt: "ignored",
    command: process.execPath,
    _argsOverride: fakeStreamArgs([
      {
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: "codex says hi"
        }
      },
      { type: "turn.completed", stop_reason: "end_turn" }
    ])
  });
  // Codex translator emits agent_message_chunk for assistant_message items.
  expect(turn.text).toBe("codex says hi");
  expect(turn.reason).toBe("end_turn");
});

test("dispatch gemini → runGeminiPrint produces TurnResult from gemini events", async () => {
  const turn = await runStatelessTurn("gemini", {
    prompt: "ignored",
    command: process.execPath,
    _argsOverride: fakeStreamArgs([
      {
        sessionUpdate: "agent_message_chunk",
        content: { text: "gemini says hi" }
      },
      { sessionUpdate: "turn_completed", reason: "end_turn" }
    ])
  });
  expect(turn.text).toBe("gemini says hi");
  expect(turn.reason).toBe("end_turn");
});

test("dispatch unknown backend → rejects with 'unknown backend' message", async () => {
  await expect(
    runStatelessTurn(/** @type {any} */ ("bedrock"), {
      prompt: "x",
      command: process.execPath,
      _argsOverride: []
    })
  ).rejects.toThrow(/unknown backend "bedrock"/);
});

test("dispatcher preserves runner failures (spawn ENOENT bubbles up)", async () => {
  // Run claude with a bad command — the runner's ENOENT rejection should
  // propagate through the dispatcher unchanged.
  await expect(
    runStatelessTurn("claude", {
      prompt: "x",
      command: "/no/such/binary/anywhere",
      _argsOverride: []
    })
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("dispatcher preserves runner abort semantics", async () => {
  const controller = new AbortController();
  const script =
    'process.stdout.write(JSON.stringify({type:"item.created",item:{type:"assistant_message",role:"assistant",content:"x"}})+"\\n"); setInterval(()=>{}, 1000);';

  const promise = runStatelessTurn("codex", {
    prompt: "x",
    command: process.execPath,
    _argsOverride: ["-e", script],
    signal: controller.signal
  });

  setTimeout(() => controller.abort(new Error("dispatcher cancel")), 50);

  await expect(promise).rejects.toThrow(/dispatcher cancel|aborted/);
});
