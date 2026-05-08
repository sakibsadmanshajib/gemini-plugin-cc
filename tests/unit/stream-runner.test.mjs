/**
 * Stream-runner integration: piping synthetic stream-json events through
 * the real translators (`translateClaudeStreamEvent`,
 * `translateCodexStreamEvent`) and asserting the accumulated TurnResult.
 *
 * Tests use `node:stream` PassThrough so there's no subprocess; we feed
 * already-line-delimited JSON and let the runner do its work. This proves
 * the translator + runner composition works end-to-end without depending
 * on the real CLI binaries.
 */

import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { translateClaudeStreamEvent } from "#lib/translate/claude-stream.mjs";
import { translateCodexStreamEvent } from "#lib/translate/codex-stream.mjs";
import { consumeStreamJson } from "#lib/translate/stream-runner.mjs";

/**
 * Helper: write a sequence of newline-delimited JSON events to a stream
 * and end it. Each entry is JSON.stringify'd separately to mirror what
 * the CLI does line-by-line.
 *
 * @param {NodeJS.ReadWriteStream} stream
 * @param {any[]} events
 */
function feedEvents(stream, events) {
  for (const event of events) {
    stream.write(`${JSON.stringify(event)}\n`);
  }
  stream.end();
}

describe("consumeStreamJson — Claude translator integration", () => {
  test("happy path: text + thinking + tool_use + result accumulates correctly", async () => {
    const stdout = new PassThrough();
    feedEvents(stdout, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check that. " },
            { type: "thinking", thinking: "Step 1: read the file." }
          ]
        }
      },
      {
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
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }]
        }
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done." }] }
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 100, output_tokens: 50 }
      }
    ]);

    const turn = await consumeStreamJson(stdout, translateClaudeStreamEvent);

    expect(turn.text).toBe("Let me check that. Done.");
    expect(turn.thoughtText).toBe("Step 1: read the file.");
    expect(turn.chunkCount).toBe(2);
    expect(turn.thoughtCount).toBe(1);
    expect(turn.toolCalls).toEqual([{ toolName: "Read", toolUseId: "tu_1", args: { path: "/x" } }]);
    expect(turn.toolResults).toEqual([{ toolUseId: "tu_1", result: "file body", isError: false }]);
    expect(turn.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(turn.reason).toBe("success");
  });

  test("EOF without result event: resolves with partial turn", async () => {
    const stdout = new PassThrough();
    feedEvents(stdout, [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Partial..." }] }
      }
      // No result event — stream just ends.
    ]);
    const turn = await consumeStreamJson(stdout, translateClaudeStreamEvent);
    expect(turn.text).toBe("Partial...");
    expect(turn.reason).toBeNull(); // never saw turn_completed
  });

  test("multi-block assistant event: all blocks accumulate from one line", async () => {
    const stdout = new PassThrough();
    feedEvents(stdout, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
            { type: "text", text: "C" }
          ]
        }
      }
    ]);
    const turn = await consumeStreamJson(stdout, translateClaudeStreamEvent);
    // Three updates from one line, joined into the running text.
    expect(turn.text).toBe("ABC");
    expect(turn.chunkCount).toBe(3);
  });

  test("system events: dropped silently (translator returns null)", async () => {
    const stdout = new PassThrough();
    /** @type {any[]} */
    const drops = [];
    feedEvents(stdout, [
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] }
      }
    ]);
    const turn = await consumeStreamJson(stdout, translateClaudeStreamEvent, {
      onUnknownEvent: (e) => drops.push(e)
    });
    expect(turn.text).toBe("ok");
    expect(drops).toHaveLength(1); // the system event
    expect(drops[0]).toMatchObject({ type: "system", subtype: "init" });
  });

  test("malformed JSON line: routed to onMalformedLine, parse continues", async () => {
    const stdout = new PassThrough();
    /** @type {string[]} */
    const malformed = [];
    stdout.write("not json at all\n");
    stdout.write(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })}\n`
    );
    stdout.end();
    const turn = await consumeStreamJson(stdout, translateClaudeStreamEvent, {
      onMalformedLine: (line) => malformed.push(line)
    });
    expect(malformed).toEqual(["not json at all"]);
    expect(turn.text).toBe("ok");
  });

  test("onUpdate callback fires per applied update", async () => {
    const stdout = new PassThrough();
    /** @type {any[]} */
    const seen = [];
    feedEvents(stdout, [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "a" }] }
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "b" }] }
      },
      { type: "result", subtype: "success" }
    ]);
    await consumeStreamJson(stdout, translateClaudeStreamEvent, {
      onUpdate: (u) => seen.push(u.sessionUpdate)
    });
    expect(seen).toEqual(["agent_message_chunk", "agent_message_chunk", "turn_completed"]);
  });
});

describe("consumeStreamJson — Codex translator integration", () => {
  test("happy path: messages + exec_command + turn.completed accumulates", async () => {
    const stdout = new PassThrough();
    feedEvents(stdout, [
      {
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: "Starting."
        }
      },
      {
        type: "exec_command.started",
        command: { id: "ec_1", command: "ls", args: ["-la"], cwd: "/repo" }
      },
      {
        type: "exec_command.output",
        output: { stdout: "file1\nfile2\n" }
      },
      {
        type: "exec_command.completed",
        command: { id: "ec_1" },
        output: { stdout: "file1\nfile2\n", stderr: "", exit_code: 0 }
      },
      {
        type: "item.created",
        item: {
          type: "assistant_message",
          role: "assistant",
          content: "Done."
        }
      },
      {
        type: "turn.completed",
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 30 }
      }
    ]);

    const turn = await consumeStreamJson(stdout, translateCodexStreamEvent);

    expect(turn.text).toBe("Starting.file1\nfile2\nDone.");
    expect(turn.toolCalls).toEqual([
      {
        toolName: "bash",
        toolUseId: "ec_1",
        args: { command: "ls", args: ["-la"], cwd: "/repo" }
      }
    ]);
    expect(turn.toolResults).toEqual([
      {
        toolUseId: "ec_1",
        result: { stdout: "file1\nfile2\n", stderr: "", exitCode: 0 },
        isError: false
      }
    ]);
    expect(turn.reason).toBe("end_turn");
    expect(turn.usage).toEqual({ input_tokens: 50, output_tokens: 30 });
  });

  test("turn_completed mid-stream: resolves immediately, ignores subsequent lines", async () => {
    const stdout = new PassThrough();
    // Write events one at a time so we can keep the stream open after the
    // turn completes — verifying that the runner closes the readline
    // interface rather than waiting for EOF.
    stdout.write(
      `${JSON.stringify({ type: "item.created", item: { type: "assistant_message", role: "assistant", content: "A" } })}\n`
    );
    stdout.write(`${JSON.stringify({ type: "turn.completed", stop_reason: "end_turn" })}\n`);

    const promise = consumeStreamJson(stdout, translateCodexStreamEvent);
    const turn = await promise;
    // After resolution, subsequent writes are no-ops at the runner level.
    stdout.write(
      `${JSON.stringify({ type: "item.created", item: { type: "assistant_message", role: "assistant", content: "B" } })}\n`
    );
    stdout.end();

    expect(turn.text).toBe("A");
    expect(turn.reason).toBe("end_turn");
  });

  test("blank lines between events: skipped", async () => {
    const stdout = new PassThrough();
    stdout.write("\n\n");
    stdout.write(
      `${JSON.stringify({ type: "item.created", item: { type: "assistant_message", role: "assistant", content: "ok" } })}\n`
    );
    stdout.write("\n");
    stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
    stdout.end();
    const turn = await consumeStreamJson(stdout, translateCodexStreamEvent);
    expect(turn.text).toBe("ok");
  });
});
