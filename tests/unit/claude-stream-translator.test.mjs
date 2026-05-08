/**
 * Unit tests for `translateClaudeStreamEvent` covering each documented
 * Claude `--print --output-format=stream-json` event shape (per
 * docs/cli-options-research.md):
 *   - assistant (text, thinking, tool_use blocks; multi-block)
 *   - user (tool_result blocks)
 *   - result (subtype + usage)
 *   - system (debug-only — null)
 *   - unknown / drift events
 */

import { describe, expect, test } from "vitest";

import { translateClaudeStreamEvent } from "#lib/translate/claude-stream.mjs";

describe("translateClaudeStreamEvent — invalid input", () => {
  test("null / undefined / non-object: null", () => {
    expect(translateClaudeStreamEvent(null)).toBeNull();
    expect(translateClaudeStreamEvent(undefined)).toBeNull();
    expect(translateClaudeStreamEvent("string")).toBeNull();
  });

  test("missing or non-string type: null", () => {
    expect(translateClaudeStreamEvent({})).toBeNull();
    expect(translateClaudeStreamEvent({ type: 42 })).toBeNull();
  });

  test("system events: null (debug-only)", () => {
    expect(translateClaudeStreamEvent({ type: "system", subtype: "init" })).toBeNull();
    expect(
      translateClaudeStreamEvent({
        type: "system",
        subtype: "compact_boundary"
      })
    ).toBeNull();
  });

  test("unknown event type: null", () => {
    expect(
      translateClaudeStreamEvent({
        type: "future.unknown_event",
        payload: "anything"
      })
    ).toBeNull();
  });
});

describe("translateClaudeStreamEvent — assistant", () => {
  test("single text block → one agent_message_chunk", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello, world." }] }
      })
    ).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Hello, world." }
      }
    ]);
  });

  test("single thinking block → one agent_thought_chunk", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Step 1: ..." }] }
      })
    ).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "Step 1: ..." }
      }
    ]);
  });

  test("thinking block with `text` field instead of `thinking`: still extracted", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: "Older shape" }] }
      })
    ).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "Older shape" }
      }
    ]);
  });

  test("single tool_use block → one tool_call", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              id: "tu_1",
              input: { path: "/x" }
            }
          ]
        }
      })
    ).toEqual([
      {
        sessionUpdate: "tool_call",
        toolName: "Read",
        toolUseId: "tu_1",
        args: { path: "/x" }
      }
    ]);
  });

  test("multi-block (text + thinking + tool_use): three updates in order", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check" },
            { type: "thinking", thinking: "Reasoning..." },
            {
              type: "tool_use",
              name: "Bash",
              id: "tu_2",
              input: { command: "ls" }
            }
          ]
        }
      })
    ).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Let me check" }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "Reasoning..." }
      },
      {
        sessionUpdate: "tool_call",
        toolName: "Bash",
        toolUseId: "tu_2",
        args: { command: "ls" }
      }
    ]);
  });

  test("empty text block: skipped", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "" }] }
      })
    ).toBeNull();
  });

  test("empty content array: null", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [] }
      })
    ).toBeNull();
  });

  test("missing message.content: null", () => {
    expect(translateClaudeStreamEvent({ type: "assistant", message: {} })).toBeNull();
  });

  test("unknown block type within content: silently skipped (not in result)", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: {
          content: [
            { type: "image", source: "..." },
            { type: "text", text: "Caption" }
          ]
        }
      })
    ).toEqual([{ sessionUpdate: "agent_message_chunk", content: { text: "Caption" } }]);
  });

  test("tool_use with missing name/id: defaults applied", () => {
    expect(
      translateClaudeStreamEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use" }] }
      })
    ).toEqual([
      {
        sessionUpdate: "tool_call",
        toolName: "unknown",
        toolUseId: "",
        args: {}
      }
    ]);
  });
});

describe("translateClaudeStreamEvent — user", () => {
  test("tool_result with string content → tool_result update", () => {
    expect(
      translateClaudeStreamEvent({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "file contents"
            }
          ]
        }
      })
    ).toEqual([
      {
        sessionUpdate: "tool_result",
        toolUseId: "tu_1",
        result: "file contents",
        isError: false
      }
    ]);
  });

  test("tool_result with content array of text blocks → joined text", () => {
    expect(
      translateClaudeStreamEvent({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              content: [
                { type: "text", text: "Line 1\n" },
                { type: "text", text: "Line 2\n" }
              ]
            }
          ]
        }
      })
    ).toEqual([
      {
        sessionUpdate: "tool_result",
        toolUseId: "tu_2",
        result: "Line 1\nLine 2\n",
        isError: false
      }
    ]);
  });

  test("tool_result with is_error: isError=true", () => {
    expect(
      translateClaudeStreamEvent({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_3",
              content: "ENOENT",
              is_error: true
            }
          ]
        }
      })
    ).toMatchObject([{ isError: true }]);
  });

  test("user event with only plain text (no tool_result): null (echo, not translatable)", () => {
    expect(
      translateClaudeStreamEvent({
        type: "user",
        message: { content: [{ type: "text", text: "user input" }] }
      })
    ).toBeNull();
  });

  test("multiple tool_result blocks: all translated", () => {
    expect(
      translateClaudeStreamEvent({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_a", content: "A" },
            { type: "tool_result", tool_use_id: "tu_b", content: "B" }
          ]
        }
      })
    ).toHaveLength(2);
  });
});

describe("translateClaudeStreamEvent — result", () => {
  test("with subtype + usage: turn_completed with reason + usage", () => {
    expect(
      translateClaudeStreamEvent({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 100, output_tokens: 50 },
        duration_ms: 2500,
        total_cost_usd: 0.01
      })
    ).toEqual([
      {
        sessionUpdate: "turn_completed",
        reason: "success",
        usage: { input_tokens: 100, output_tokens: 50 }
      }
    ]);
  });

  test("with stop_reason but no subtype: stop_reason becomes the reason", () => {
    expect(translateClaudeStreamEvent({ type: "result", stop_reason: "end_turn" })).toEqual([
      { sessionUpdate: "turn_completed", reason: "end_turn" }
    ]);
  });

  test("subtype takes precedence over stop_reason when both present", () => {
    expect(
      translateClaudeStreamEvent({
        type: "result",
        subtype: "error_max_turns",
        stop_reason: "end_turn"
      })
    ).toMatchObject([{ reason: "error_max_turns" }]);
  });

  test("with cache-related usage fields: passed through verbatim", () => {
    expect(
      translateClaudeStreamEvent({
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 800
        }
      })
    ).toEqual([
      {
        sessionUpdate: "turn_completed",
        reason: "success",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 800
        }
      }
    ]);
  });

  test("bare result: just turn_completed sessionUpdate", () => {
    expect(translateClaudeStreamEvent({ type: "result" })).toEqual([
      { sessionUpdate: "turn_completed" }
    ]);
  });
});
