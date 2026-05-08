/**
 * Unit tests for `translateCodexStreamEvent` covering each documented
 * codex `exec --json` event shape (per docs/cli-options-research.md):
 *   - item.created (assistant_message, reasoning, tool_call, tool_result)
 *   - exec_command.{started,output,completed}
 *   - turn.completed
 *   - unknown / drift events
 */

import { describe, expect, test } from "vitest";

import { translateCodexStreamEvent } from "#lib/translate/codex-stream.mjs";

describe("translateCodexStreamEvent — invalid input", () => {
  test("null / undefined / non-object: null", () => {
    expect(translateCodexStreamEvent(null)).toBeNull();
    expect(translateCodexStreamEvent(undefined)).toBeNull();
    expect(translateCodexStreamEvent("string")).toBeNull();
    expect(translateCodexStreamEvent(42)).toBeNull();
  });

  test("missing or non-string type: null", () => {
    expect(translateCodexStreamEvent({})).toBeNull();
    expect(translateCodexStreamEvent({ type: 42 })).toBeNull();
  });

  test("unknown type: null (drift signal)", () => {
    expect(
      translateCodexStreamEvent({
        type: "future.unknown_event",
        payload: "anything"
      })
    ).toBeNull();
  });
});

describe("translateCodexStreamEvent — item.created", () => {
  test("assistant_message with string content: agent_message_chunk", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: "Hello, world."
        }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "Hello, world." }
    });
  });

  test("assistant_message with content array of text blocks: joined text", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world." }
          ]
        }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "Hello, world." }
    });
  });

  test("assistant role 'reasoning' → agent_thought_chunk", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "reasoning",
          content: "Thinking..."
        }
      })
    ).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Thinking..." }
    });
  });

  test("explicit reasoning item type → agent_thought_chunk", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: { type: "reasoning", content: "Step 1: identify the bug." }
      })
    ).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Step 1: identify the bug." }
    });
  });

  test("tool_call: emits sessionUpdate=tool_call with name + args + id", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "tool_call",
          name: "read_file",
          id: "tu_1",
          arguments: { path: "/x" }
        }
      })
    ).toEqual({
      sessionUpdate: "tool_call",
      toolName: "read_file",
      toolUseId: "tu_1",
      args: { path: "/x" }
    });
  });

  test("tool_call with missing id/name: defaults to empty/unknown", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: { type: "tool_call" }
      })
    ).toEqual({
      sessionUpdate: "tool_call",
      toolName: "unknown",
      toolUseId: "",
      args: {}
    });
  });

  test("tool_result: emits sessionUpdate=tool_result with output + isError", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "tool_result",
          id: "tu_1",
          output: "file contents",
          is_error: false
        }
      })
    ).toEqual({
      sessionUpdate: "tool_result",
      toolUseId: "tu_1",
      result: "file contents",
      isError: false
    });
  });

  test("tool_result with is_error: isError=true", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: {
          type: "tool_result",
          id: "tu_2",
          output: "ENOENT",
          is_error: true
        }
      })
    ).toMatchObject({
      sessionUpdate: "tool_result",
      toolUseId: "tu_2",
      isError: true
    });
  });

  test("unknown item type: null (drift signal)", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: { type: "future.media_block", payload: "any" }
      })
    ).toBeNull();
  });

  test("missing item: null", () => {
    expect(translateCodexStreamEvent({ type: "item.created" })).toBeNull();
  });

  test("assistant_message with null content: null", () => {
    expect(
      translateCodexStreamEvent({
        type: "item.created",
        item: { type: "assistant_message", content: null }
      })
    ).toBeNull();
  });
});

describe("translateCodexStreamEvent — exec_command.*", () => {
  test("exec_command.started → tool_call with toolName='bash'", () => {
    expect(
      translateCodexStreamEvent({
        type: "exec_command.started",
        command: {
          id: "ec_1",
          command: "rg",
          args: ["pattern", "src"],
          cwd: "/repo"
        }
      })
    ).toEqual({
      sessionUpdate: "tool_call",
      toolName: "bash",
      toolUseId: "ec_1",
      args: { command: "rg", args: ["pattern", "src"], cwd: "/repo" }
    });
  });

  test("exec_command.output stdout → agent_message_chunk", () => {
    expect(
      translateCodexStreamEvent({
        type: "exec_command.output",
        output: { stdout: "match line 1\n" }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "match line 1\n" }
    });
  });

  test("exec_command.output stderr-only → agent_message_chunk", () => {
    expect(
      translateCodexStreamEvent({
        type: "exec_command.output",
        output: { stderr: "warn: deprecated\n" }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "warn: deprecated\n" }
    });
  });

  test("exec_command.output with empty/missing output: null", () => {
    expect(translateCodexStreamEvent({ type: "exec_command.output" })).toBeNull();
    expect(translateCodexStreamEvent({ type: "exec_command.output", output: {} })).toBeNull();
    expect(
      translateCodexStreamEvent({
        type: "exec_command.output",
        output: { stdout: "" }
      })
    ).toBeNull();
  });

  test("exec_command.completed exit_code 0 → tool_result isError=false", () => {
    expect(
      translateCodexStreamEvent({
        type: "exec_command.completed",
        command: { id: "ec_1" },
        output: { stdout: "ok\n", stderr: "", exit_code: 0 }
      })
    ).toEqual({
      sessionUpdate: "tool_result",
      toolUseId: "ec_1",
      result: { stdout: "ok\n", stderr: "", exitCode: 0 },
      isError: false
    });
  });

  test("exec_command.completed nonzero exit → isError=true", () => {
    expect(
      translateCodexStreamEvent({
        type: "exec_command.completed",
        command: { id: "ec_2" },
        output: { stdout: "", stderr: "boom", exit_code: 1 }
      })
    ).toMatchObject({ isError: true });
  });
});

describe("translateCodexStreamEvent — turn.completed", () => {
  test("with usage + stop_reason: full turn_completed shape", () => {
    expect(
      translateCodexStreamEvent({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        stop_reason: "end_turn",
        duration_ms: 1234
      })
    ).toEqual({
      sessionUpdate: "turn_completed",
      reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 }
    });
  });

  test("without usage: minimal shape", () => {
    expect(
      translateCodexStreamEvent({
        type: "turn.completed",
        stop_reason: "max_turns"
      })
    ).toEqual({ sessionUpdate: "turn_completed", reason: "max_turns" });
  });

  test("without stop_reason or usage: just sessionUpdate", () => {
    expect(translateCodexStreamEvent({ type: "turn.completed" })).toEqual({
      sessionUpdate: "turn_completed"
    });
  });

  test("with usage having missing fields: defaults to 0", () => {
    expect(
      translateCodexStreamEvent({
        type: "turn.completed",
        usage: { input_tokens: 50 }
      })
    ).toMatchObject({ usage: { input_tokens: 50, output_tokens: 0 } });
  });
});
