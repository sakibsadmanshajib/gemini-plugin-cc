/**
 * Tests for runGeminiPrint — pure-function argv tests for
 * buildGeminiPrintArgs + spawn integration via synthetic node -e fakes.
 *
 * Same hermetic pattern as run-claude-print.test.mjs and
 * run-codex-exec.test.mjs: build a `node -e` one-liner that emits
 * gemini-style stream-json events on stdout, override the runner's
 * args via `_argsOverride` so node's argv parser doesn't choke on
 * gemini's flags, assert on the accumulated TurnResult.
 */

import { afterEach, describe, expect, test } from "vitest";

import { buildGeminiPrintArgs, runGeminiPrint } from "#lib/runners/gemini-print.mjs";

/**
 * Build args for `node -e <script>` that emits the given JSON events as
 * stream-json (newline-delimited) on stdout, then exits 0.
 *
 * @param {any[]} events
 * @returns {string[]}
 */
function fakeGeminiArgs(events) {
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return ["-e", `process.stdout.write(${JSON.stringify(payload)});`];
}

/**
 * @param {string} stderrText
 * @param {number} exitCode
 */
function fakeGeminiFailureArgs(stderrText, exitCode) {
  return ["-e", `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(${exitCode});`];
}

/** @type {AbortController[]} */
const controllers = [];
afterEach(() => {
  for (const c of controllers) c.abort();
  controllers.length = 0;
});

describe("buildGeminiPrintArgs (pure argv)", () => {
  test("default: emits -o stream-json -p <prompt>", () => {
    expect(buildGeminiPrintArgs({ prompt: "hello" })).toEqual(["-o", "stream-json", "-p", "hello"]);
  });

  test("approvalMode: --approval-mode <mode> before -p", () => {
    expect(buildGeminiPrintArgs({ prompt: "p", approvalMode: "plan" })).toEqual([
      "-o",
      "stream-json",
      "--approval-mode",
      "plan",
      "-p",
      "p"
    ]);
  });

  test("yolo: --yolo (no value)", () => {
    expect(buildGeminiPrintArgs({ prompt: "p", yolo: true })).toEqual([
      "-o",
      "stream-json",
      "--yolo",
      "-p",
      "p"
    ]);
  });

  test("approvalMode wins over yolo when both set (mutual exclusion)", () => {
    expect(
      buildGeminiPrintArgs({
        prompt: "p",
        approvalMode: "auto_edit",
        yolo: true
      })
    ).toEqual(["-o", "stream-json", "--approval-mode", "auto_edit", "-p", "p"]);
  });

  test("model: -m <id>", () => {
    expect(buildGeminiPrintArgs({ prompt: "p", model: "gemini-3-flash-preview" })).toEqual([
      "-o",
      "stream-json",
      "-m",
      "gemini-3-flash-preview",
      "-p",
      "p"
    ]);
  });

  test("includeDirectories: comma-joined", () => {
    expect(buildGeminiPrintArgs({ prompt: "p", includeDirectories: ["/a", "/b/c"] })).toEqual([
      "-o",
      "stream-json",
      "--include-directories",
      "/a,/b/c",
      "-p",
      "p"
    ]);
  });

  test("includeDirectories empty array: dropped", () => {
    expect(buildGeminiPrintArgs({ prompt: "p", includeDirectories: [] })).toEqual([
      "-o",
      "stream-json",
      "-p",
      "p"
    ]);
  });

  test("extraArgs: appended before -p so prompt stays last", () => {
    expect(
      buildGeminiPrintArgs({
        prompt: "p",
        extraArgs: ["--screen-reader", "--debug"]
      })
    ).toEqual(["-o", "stream-json", "--screen-reader", "--debug", "-p", "p"]);
  });

  test("kitchen sink: stable order across all knobs", () => {
    expect(
      buildGeminiPrintArgs({
        prompt: "the prompt",
        approvalMode: "plan",
        model: "gemini-3-pro-preview",
        includeDirectories: ["/repo"],
        extraArgs: ["--debug"]
      })
    ).toEqual([
      "-o",
      "stream-json",
      "--approval-mode",
      "plan",
      "-m",
      "gemini-3-pro-preview",
      "--include-directories",
      "/repo",
      "--debug",
      "-p",
      "the prompt"
    ]);
  });

  test("prompt starting with dash: lands as -p value (not re-interpreted as flag)", () => {
    const args = buildGeminiPrintArgs({ prompt: "--not-a-flag" });
    // `-p` precedes the value, so flag parsers won't swallow `--not-a-flag` as a separate flag.
    expect(args.slice(-2)).toEqual(["-p", "--not-a-flag"]);
  });
});

describe("runGeminiPrint (spawn integration)", () => {
  test("happy path: bare ACP events accumulate to TurnResult", async () => {
    const turn = await runGeminiPrint({
      prompt: "ignored by fake",
      command: process.execPath,
      _argsOverride: fakeGeminiArgs([
        {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Hello." }
        },
        {
          sessionUpdate: "turn_completed",
          reason: "end_turn",
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
          }
        }
      ])
    });
    expect(turn.text).toBe("Hello.");
    expect(turn.reason).toBe("end_turn");
    expect(turn.usage).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15
    });
  });

  test("JSON-RPC envelope: unwrapped by translator, accumulates correctly", async () => {
    const turn = await runGeminiPrint({
      prompt: "ignored",
      command: process.execPath,
      _argsOverride: fakeGeminiArgs([
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "wrapped" }
            }
          }
        },
        { sessionUpdate: "turn_completed" }
      ])
    });
    expect(turn.text).toBe("wrapped");
  });

  test("multi-event session: text + tool_call + tool_result + turn_completed", async () => {
    const turn = await runGeminiPrint({
      prompt: "ignored",
      command: process.execPath,
      _argsOverride: fakeGeminiArgs([
        {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Reading file. " }
        },
        {
          sessionUpdate: "tool_call",
          toolName: "read_file",
          toolUseId: "tu_1",
          args: { path: "/x" }
        },
        {
          sessionUpdate: "tool_result",
          toolUseId: "tu_1",
          result: "file contents",
          isError: false
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Done." }
        },
        { sessionUpdate: "turn_completed", reason: "end_turn" }
      ])
    });

    expect(turn.text).toBe("Reading file. Done.");
    expect(turn.toolCalls).toEqual([
      { toolName: "read_file", toolUseId: "tu_1", args: { path: "/x" } }
    ]);
    expect(turn.toolResults).toEqual([
      { toolUseId: "tu_1", result: "file contents", isError: false }
    ]);
  });

  test("missing prompt rejects", async () => {
    await expect(
      runGeminiPrint(
        /** @type {any} */ ({
          command: process.execPath,
          _argsOverride: ["-e", "process.exit(0)"]
        })
      )
    ).rejects.toThrow(/prompt is required/i);
  });

  test("spawn ENOENT rejects with the spawn error", async () => {
    await expect(
      runGeminiPrint({
        prompt: "x",
        command: "/no/such/binary/anywhere",
        _argsOverride: []
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("child exits non-zero rejects with exitCode + stderr", async () => {
    await expect(
      runGeminiPrint({
        prompt: "x",
        command: process.execPath,
        _argsOverride: fakeGeminiFailureArgs("auth required\n", 3)
      })
    ).rejects.toMatchObject({ exitCode: 3, stderr: "auth required" });
  });

  test("aborted via signal kills the child", async () => {
    const script =
      'process.stdout.write(JSON.stringify({sessionUpdate:"agent_message_chunk",content:{text:"x"}})+"\\n"); setInterval(()=>{}, 1000);';

    const controller = new AbortController();
    controllers.push(controller);

    const promise = runGeminiPrint({
      prompt: "x",
      command: process.execPath,
      _argsOverride: ["-e", script],
      signal: controller.signal
    });

    setTimeout(() => controller.abort(new Error("test cancel")), 50);

    await expect(promise).rejects.toThrow(/test cancel|aborted/);
  });

  test("timeoutMs SIGTERMs the child and rejects", async () => {
    const script =
      'process.stdout.write(JSON.stringify({sessionUpdate:"agent_message_chunk",content:{text:"partial"}})+"\\n"); setInterval(()=>{}, 10000);';

    await expect(
      runGeminiPrint({
        prompt: "x",
        command: process.execPath,
        _argsOverride: ["-e", script],
        timeoutMs: 100
      })
    ).rejects.toThrow(/timed out after 100ms/);
  });

  test("timeoutMs that doesn't fire: happy path still wins", async () => {
    const turn = await runGeminiPrint({
      prompt: "x",
      command: process.execPath,
      _argsOverride: fakeGeminiArgs([
        { sessionUpdate: "agent_message_chunk", content: { text: "fast" } },
        { sessionUpdate: "turn_completed", reason: "end_turn" }
      ]),
      timeoutMs: 5000
    });
    expect(turn.text).toBe("fast");
    expect(turn.reason).toBe("end_turn");
  });

  test("file_change events are dropped (not in TurnResult.text)", async () => {
    const turn = await runGeminiPrint({
      prompt: "ignored",
      command: process.execPath,
      _argsOverride: fakeGeminiArgs([
        { sessionUpdate: "agent_message_chunk", content: { text: "text " } },
        { sessionUpdate: "file_change", path: "/x.ts", action: "modify" },
        { sessionUpdate: "agent_message_chunk", content: { text: "after." } },
        { sessionUpdate: "turn_completed" }
      ])
    });
    expect(turn.text).toBe("text after.");
  });
});
