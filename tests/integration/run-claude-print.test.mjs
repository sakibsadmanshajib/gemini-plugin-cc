/**
 * Integration test: runClaudePrint spawning a fake claude binary that
 * emits synthetic stream-json events.
 *
 * The fake binary is a `node -e` one-liner that writes a sequence of
 * stream-json events to stdout and exits cleanly. We bypass the
 * canonical claude argv via `_argsOverride` (a documented test seam)
 * because `node -e` doesn't tolerate the real claude flags being
 * appended to its own argv — node tries to parse `--output-format` as
 * a node flag and exits 9.
 *
 * Real-binary smoke testing belongs in a separate manual script. CI
 * uses these synthetic fakes — same pattern as `tests/mocks/gemini-mock.mjs`.
 */

import { afterEach, expect, test } from "vitest";

import { runClaudePrint } from "#lib/runners/claude-print.mjs";

/**
 * Build args for `node -e <script>` that emits the given JSON events as
 * stream-json (newline-delimited) on stdout, then exits 0.
 *
 * @param {any[]} events
 * @returns {string[]}
 */
function fakeClaudeArgs(events) {
  // Build the actual newline-delimited payload (real \n chars, one per
  // event), then JSON.stringify it so the script string contains the
  // proper escaped newlines that node's parser turns back into real \n
  // when it evaluates the literal.
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const script = `process.stdout.write(${JSON.stringify(payload)});`;
  return ["-e", script];
}

/**
 * Build args for a fake that exits non-zero with stderr.
 *
 * @param {string} stderrText
 * @param {number} exitCode
 */
function fakeClaudeFailureArgs(stderrText, exitCode) {
  const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(${exitCode});`;
  return ["-e", script];
}

/** @type {AbortController[]} */
const controllers = [];
afterEach(() => {
  for (const c of controllers) c.abort();
  controllers.length = 0;
});

test("runClaudePrint: happy path returns accumulated TurnResult", async () => {
  const turn = await runClaudePrint({
    prompt: "ignored by fake",
    command: process.execPath,
    _argsOverride: fakeClaudeArgs([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello." }] }
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    ])
  });
  expect(turn.text).toBe("Hello.");
  expect(turn.reason).toBe("success");
  expect(turn.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
});

test("runClaudePrint: multi-block + tool_use accumulates", async () => {
  const turn = await runClaudePrint({
    prompt: "ignored",
    command: process.execPath,
    _argsOverride: fakeClaudeArgs([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading file. " },
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
      { type: "result", subtype: "success" }
    ])
  });

  expect(turn.text).toBe("Reading file. Done.");
  expect(turn.toolCalls).toEqual([{ toolName: "Read", toolUseId: "tu_1", args: { path: "/x" } }]);
  expect(turn.toolResults).toEqual([{ toolUseId: "tu_1", result: "file body", isError: false }]);
});

test("runClaudePrint: missing prompt rejects", async () => {
  await expect(
    runClaudePrint(
      /** @type {any} */ ({
        command: process.execPath,
        _argsOverride: ["-e", "process.exit(0)"]
      })
    )
  ).rejects.toThrow(/prompt is required/i);
});

test("runClaudePrint: spawn ENOENT rejects with the spawn error", async () => {
  await expect(
    runClaudePrint({
      prompt: "x",
      command: "/no/such/binary/anywhere",
      _argsOverride: []
    })
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("runClaudePrint: child exits non-zero rejects with exitCode + stderr", async () => {
  await expect(
    runClaudePrint({
      prompt: "x",
      command: process.execPath,
      _argsOverride: fakeClaudeFailureArgs("auth failed\n", 1)
    })
  ).rejects.toMatchObject({ exitCode: 1, stderr: "auth failed" });
});

test("runClaudePrint: timeoutMs SIGTERMs the child and rejects", async () => {
  // Fake that emits a partial event and runs forever — only timeoutMs
  // can stop it.
  const script =
    'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"partial"}]}})+"\\n"); setInterval(()=>{}, 10000);';

  await expect(
    runClaudePrint({
      prompt: "x",
      command: process.execPath,
      _argsOverride: ["-e", script],
      timeoutMs: 100
    })
  ).rejects.toThrow(/timed out after 100ms/);
});

test("runClaudePrint: timeoutMs that doesn't fire — happy path still wins", async () => {
  // Fast-completing fake; timeout is far longer than the script's emit.
  const turn = await runClaudePrint({
    prompt: "x",
    command: process.execPath,
    _argsOverride: fakeClaudeArgs([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "fast" }] }
      },
      { type: "result", subtype: "success" }
    ]),
    timeoutMs: 5000
  });
  expect(turn.text).toBe("fast");
  expect(turn.reason).toBe("success");
});

test("runClaudePrint: aborted via signal kills the child", async () => {
  // Long-running fake that writes a partial event and waits forever.
  const script =
    'process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"partial"}]}})+"\\n"); setInterval(()=>{}, 1000);';

  const controller = new AbortController();
  controllers.push(controller);

  const promise = runClaudePrint({
    prompt: "x",
    command: process.execPath,
    _argsOverride: ["-e", script],
    signal: controller.signal
  });

  setTimeout(() => controller.abort(new Error("test cancel")), 50);

  await expect(promise).rejects.toThrow(/test cancel|aborted/);
});
