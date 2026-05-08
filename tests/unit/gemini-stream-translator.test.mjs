/**
 * Unit tests for `translateGeminiStreamEvent` covering documented event
 * shapes from gemini's `-o stream-json` output (per
 * docs/cli-options-research.md).
 *
 * Gemini's stream-json output is mostly already-ACP shape; the
 * translator handles JSON-RPC envelope unwrap + bare-event passthrough.
 */

import { describe, expect, test } from "vitest";

import { translateGeminiStreamEvent } from "#lib/translate/gemini-stream.mjs";

describe("translateGeminiStreamEvent — invalid input", () => {
  test("null / undefined / non-object: null", () => {
    expect(translateGeminiStreamEvent(null)).toBeNull();
    expect(translateGeminiStreamEvent(undefined)).toBeNull();
    expect(translateGeminiStreamEvent("string")).toBeNull();
  });

  test("missing event kind: null", () => {
    expect(translateGeminiStreamEvent({})).toBeNull();
    expect(translateGeminiStreamEvent({ method: "session/update", params: {} })).toBeNull();
  });

  test("unknown event kind: null (drift signal)", () => {
    expect(translateGeminiStreamEvent({ sessionUpdate: "future.unknown_kind" })).toBeNull();
  });
});

describe("translateGeminiStreamEvent — bare ACP shapes (passthrough)", () => {
  test("agent_message_chunk: passthrough text", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "agent_message_chunk",
        content: { text: "Hello." }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "Hello." }
    });
  });

  test("agent_message_chunk with bare {text}: also accepted", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "agent_message_chunk",
        text: "World."
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "World." }
    });
  });

  test("agent_thought_chunk: passthrough", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "agent_thought_chunk",
        content: { text: "Reasoning..." }
      })
    ).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Reasoning..." }
    });
  });

  test("empty text: dropped", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "agent_message_chunk",
        content: { text: "" }
      })
    ).toBeNull();
  });

  test("tool_call: emits with toolName + toolUseId + args", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "tool_call",
        toolName: "read_file",
        toolUseId: "tu_1",
        args: { path: "/x" }
      })
    ).toEqual({
      sessionUpdate: "tool_call",
      toolName: "read_file",
      toolUseId: "tu_1",
      args: { path: "/x" }
    });
  });

  test("tool_call with `name` instead of `toolName`: also accepted", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "tool_call",
        name: "read_file",
        toolUseId: "tu_1"
      })
    ).toMatchObject({ toolName: "read_file" });
  });

  test("tool_result: passthrough", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "tool_result",
        toolUseId: "tu_2",
        result: "the output",
        isError: false
      })
    ).toEqual({
      sessionUpdate: "tool_result",
      toolUseId: "tu_2",
      result: "the output",
      isError: false
    });
  });

  test("turn_completed with usage + reason", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "turn_completed",
        reason: "end_turn",
        usage: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150
        }
      })
    ).toEqual({
      sessionUpdate: "turn_completed",
      reason: "end_turn",
      usage: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150
      }
    });
  });

  test("turn_completed bare: just sessionUpdate", () => {
    expect(translateGeminiStreamEvent({ sessionUpdate: "turn_completed" })).toEqual({
      sessionUpdate: "turn_completed"
    });
  });

  test("file_change: returns null (no ACP target)", () => {
    expect(
      translateGeminiStreamEvent({
        sessionUpdate: "file_change",
        path: "/file.ts",
        action: "modify"
      })
    ).toBeNull();
  });
});

describe("translateGeminiStreamEvent — JSON-RPC envelope unwrap", () => {
  test("session/update wrapper: extracts inner update", () => {
    expect(
      translateGeminiStreamEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "wrapped" }
          }
        }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "wrapped" }
    });
  });

  test("envelope without inner update: null", () => {
    expect(
      translateGeminiStreamEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1" }
      })
    ).toBeNull();
  });

  test("non-session/update method: falls through to bare-event handling", () => {
    // The translator only unwraps when method === "session/update".
    // Other methods are treated as bare events, which means without a
    // sessionUpdate field they return null.
    expect(
      translateGeminiStreamEvent({
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: "hi" }
      })
    ).toBeNull();
  });
});

describe("translateGeminiStreamEvent — `type` alias for sessionUpdate", () => {
  test("bare type field also accepted", () => {
    // Some event emitters use `type` instead of `sessionUpdate`. The
    // translator accepts either to be tolerant of upstream drift.
    expect(
      translateGeminiStreamEvent({
        type: "agent_message_chunk",
        content: { text: "via type" }
      })
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { text: "via type" }
    });
  });
});
