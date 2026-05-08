/**
 * Tests for runCodexExec — spawn integration via synthetic node -e fakes,
 * plus pure-function argv tests for buildCodexExecArgs.
 *
 * Same hermetic pattern as run-claude-print.test.mjs: build a `node -e`
 * one-liner that emits the codex stream-json event shape, override the
 * runner's args via `_argsOverride` so node's argv parser doesn't choke
 * on codex's flags, assert on the accumulated TurnResult.
 */

import { afterEach, describe, expect, test } from "vitest";

import { buildCodexExecArgs, runCodexExec } from "#lib/runners/codex-exec.mjs";

/**
 * Build args for `node -e <script>` that emits the given JSON events as
 * stream-json (newline-delimited) on stdout, then exits 0.
 *
 * @param {any[]} events
 * @returns {string[]}
 */
function fakeCodexArgs(events) {
  // Real \n chars in the payload → JSON.stringify produces escaped \n
  // → node parses back to real \n when running the literal.
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const script = `process.stdout.write(${JSON.stringify(payload)});`;
  return ["-e", script];
}

/**
 * Build args for a fake that exits non-zero with stderr.
 */
function fakeCodexFailureArgs(/** @type {string} */ stderrText, /** @type {number} */ exitCode) {
  const script = `process.stderr.write(${JSON.stringify(stderrText)}); process.exit(${exitCode});`;
  return ["-e", script];
}

/** @type {AbortController[]} */
const controllers = [];
afterEach(() => {
  for (const c of controllers) c.abort();
  controllers.length = 0;
});

describe("buildCodexExecArgs (pure argv)", () => {
  test("default: emits exec --json <prompt>", () => {
    expect(buildCodexExecArgs({ prompt: "hello" })).toEqual(["exec", "--json", "hello"]);
  });

  test("model: --model <id> before prompt", () => {
    expect(buildCodexExecArgs({ prompt: "p", model: "gpt-5-codex" })).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5-codex",
      "p"
    ]);
  });

  test("effort: --effort <level>", () => {
    expect(buildCodexExecArgs({ prompt: "p", effort: "high" })).toEqual([
      "exec",
      "--json",
      "--effort",
      "high",
      "p"
    ]);
  });

  test("profile: --profile <name>", () => {
    expect(buildCodexExecArgs({ prompt: "p", profile: "dev" })).toEqual([
      "exec",
      "--json",
      "--profile",
      "dev",
      "p"
    ]);
  });

  test("configOverrides: -c key=value pairs", () => {
    expect(
      buildCodexExecArgs({
        prompt: "p",
        configOverrides: { model: "o3", reasoning_effort: "high" }
      })
    ).toEqual(["exec", "--json", "-c", "model=o3", "-c", "reasoning_effort=high", "p"]);
  });

  test("quiet: --quiet", () => {
    expect(buildCodexExecArgs({ prompt: "p", quiet: true })).toEqual([
      "exec",
      "--json",
      "--quiet",
      "p"
    ]);
  });

  test("extraArgs: appended before prompt", () => {
    expect(buildCodexExecArgs({ prompt: "p", extraArgs: ["--debug", "api"] })).toEqual([
      "exec",
      "--json",
      "--debug",
      "api",
      "p"
    ]);
  });

  test("kitchen sink: stable order with model + effort + extras + prompt last", () => {
    expect(
      buildCodexExecArgs({
        prompt: "the prompt",
        model: "spark",
        effort: "high",
        profile: "dev",
        configOverrides: { sandbox: "read-only" },
        quiet: true,
        extraArgs: ["--enable", "exp_feature"]
      })
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "spark",
      "--effort",
      "high",
      "--profile",
      "dev",
      "-c",
      "sandbox=read-only",
      "--quiet",
      "--enable",
      "exp_feature",
      "the prompt"
    ]);
  });

  test("prompt starting with dash: lands last so flag parsing doesn't swallow it", () => {
    // Defensive: a prompt that looks like a flag must not be re-interpreted
    // as one. Prompt-last positioning + the implicit `--`-style boundary
    // codex applies for positional args ensures this works.
    const args = buildCodexExecArgs({ prompt: "--not-a-flag" });
    expect(args[args.length - 1]).toBe("--not-a-flag");
  });
});

describe("runCodexExec (spawn integration)", () => {
  test("happy path: messages + exec_command + turn.completed → TurnResult", async () => {
    const turn = await runCodexExec({
      prompt: "ignored by fake",
      command: process.execPath,
      _argsOverride: fakeCodexArgs([
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
          type: "exec_command.completed",
          command: { id: "ec_1" },
          output: { stdout: "files\n", stderr: "", exit_code: 0 }
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
      ])
    });

    expect(turn.text).toBe("Starting.Done.");
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
        result: { stdout: "files\n", stderr: "", exitCode: 0 },
        isError: false
      }
    ]);
    expect(turn.reason).toBe("end_turn");
    expect(turn.usage).toEqual({ input_tokens: 50, output_tokens: 30 });
  });

  test("missing prompt rejects", async () => {
    await expect(
      runCodexExec(
        /** @type {any} */ ({
          command: process.execPath,
          _argsOverride: ["-e", "process.exit(0)"]
        })
      )
    ).rejects.toThrow(/prompt is required/i);
  });

  test("spawn ENOENT rejects with the spawn error", async () => {
    await expect(
      runCodexExec({
        prompt: "x",
        command: "/no/such/binary/anywhere",
        _argsOverride: []
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("child exits non-zero rejects with exitCode + stderr", async () => {
    await expect(
      runCodexExec({
        prompt: "x",
        command: process.execPath,
        _argsOverride: fakeCodexFailureArgs("rate limited\n", 2)
      })
    ).rejects.toMatchObject({ exitCode: 2, stderr: "rate limited" });
  });

  test("timeoutMs SIGTERMs the child and rejects", async () => {
    const script =
      'process.stdout.write(JSON.stringify({type:"item.created",item:{type:"assistant_message",role:"assistant",content:"partial"}})+"\\n"); setInterval(()=>{}, 10000);';

    await expect(
      runCodexExec({
        prompt: "x",
        command: process.execPath,
        _argsOverride: ["-e", script],
        timeoutMs: 100
      })
    ).rejects.toThrow(/timed out after 100ms/);
  });

  test("timeoutMs that doesn't fire — happy path still wins", async () => {
    const turn = await runCodexExec({
      prompt: "x",
      command: process.execPath,
      _argsOverride: fakeCodexArgs([
        {
          type: "item.created",
          item: {
            type: "assistant_message",
            role: "assistant",
            content: "fast"
          }
        },
        { type: "turn.completed", stop_reason: "end_turn" }
      ]),
      timeoutMs: 5000
    });
    expect(turn.text).toBe("fast");
    expect(turn.reason).toBe("end_turn");
  });

  test("aborted via signal kills the child", async () => {
    // Long-running fake.
    const script =
      'process.stdout.write(JSON.stringify({type:"item.created",item:{type:"assistant_message",role:"assistant",content:"partial"}})+"\\n"); setInterval(()=>{}, 1000);';

    const controller = new AbortController();
    controllers.push(controller);

    const promise = runCodexExec({
      prompt: "x",
      command: process.execPath,
      _argsOverride: ["-e", script],
      signal: controller.signal
    });

    setTimeout(() => controller.abort(new Error("test cancel")), 50);

    await expect(promise).rejects.toThrow(/test cancel|aborted/);
  });
});
