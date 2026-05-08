/**
 * Argv-emission tests for `buildClaudeArgs`.
 *
 * Sourced from `docs/cli-options-research.md`. Each option is tested in
 * isolation (default + explicit) plus the print-only validation path and
 * the continue/resume mutual-exclusion rule.
 */

import { describe, expect, test } from "vitest";

import { buildClaudeArgs } from "#lib/backends/claude.mjs";

describe("buildClaudeArgs — operation modes", () => {
  test("default: emits empty args (interactive launch)", () => {
    expect(buildClaudeArgs()).toEqual([]);
    expect(buildClaudeArgs({})).toEqual([]);
  });

  test("print: --print", () => {
    expect(buildClaudeArgs({ print: true })).toEqual(["--print"]);
  });

  test("continue: --continue", () => {
    expect(buildClaudeArgs({ continue: true })).toEqual(["--continue"]);
  });

  test("resume true (picker): --resume with no value", () => {
    expect(buildClaudeArgs({ resume: true })).toEqual(["--resume"]);
  });

  test("resume <id>: --resume <id>", () => {
    expect(buildClaudeArgs({ resume: "abc-123" })).toEqual(["--resume", "abc-123"]);
  });

  test("continue + resume: throws (mutually exclusive)", () => {
    expect(() => buildClaudeArgs({ continue: true, resume: "x" })).toThrow(/mutually exclusive/i);
    expect(() => buildClaudeArgs({ continue: true, resume: true })).toThrow(/mutually exclusive/i);
  });
});

describe("buildClaudeArgs — session identity", () => {
  test("sessionId: --session-id <uuid> (alone, no --resume)", () => {
    expect(buildClaudeArgs({ sessionId: "550e8400-e29b-41d4-a716-446655440000" })).toEqual([
      "--session-id",
      "550e8400-e29b-41d4-a716-446655440000"
    ]);
  });

  test("forkSession: --fork-session, useful with resume", () => {
    expect(buildClaudeArgs({ resume: "old-id", forkSession: true })).toEqual([
      "--resume",
      "old-id",
      "--fork-session"
    ]);
  });

  test("forkSession standalone (no resume): emitted but means nothing without resume — caller's responsibility", () => {
    expect(buildClaudeArgs({ forkSession: true })).toEqual(["--fork-session"]);
  });
});

describe("buildClaudeArgs — print-only validation", () => {
  test("noSessionPersistence without print: throws", () => {
    expect(() => buildClaudeArgs({ noSessionPersistence: true })).toThrow(/require print: true/);
  });

  test("outputFormat=json without print: throws", () => {
    expect(() => buildClaudeArgs({ outputFormat: "json" })).toThrow(/require print: true/);
  });

  test("outputFormat=text without print: ALLOWED (text is the default)", () => {
    expect(buildClaudeArgs({ outputFormat: "text" })).toEqual(["--output-format", "text"]);
  });

  test("inputFormat without print: throws", () => {
    expect(() => buildClaudeArgs({ inputFormat: "stream-json" })).toThrow(/require print: true/);
  });

  test("fallbackModel without print: throws", () => {
    expect(() => buildClaudeArgs({ fallbackModel: "haiku" })).toThrow(/require print: true/);
  });

  test("maxBudgetUsd without print: throws", () => {
    expect(() => buildClaudeArgs({ maxBudgetUsd: 5 })).toThrow(/require print: true/);
  });

  test("includePartialMessages without print: throws", () => {
    expect(() => buildClaudeArgs({ includePartialMessages: true })).toThrow(/require print: true/);
  });

  test("includeHookEvents without print: throws", () => {
    expect(() => buildClaudeArgs({ includeHookEvents: true })).toThrow(/require print: true/);
  });

  test("multiple print-only flags without print: throws with all named", () => {
    expect(() =>
      buildClaudeArgs({
        noSessionPersistence: true,
        outputFormat: "json",
        maxBudgetUsd: 1
      })
    ).toThrow(/noSessionPersistence.*outputFormat.*maxBudgetUsd/);
  });

  test("print + all the print-only flags: passes through", () => {
    expect(
      buildClaudeArgs({
        print: true,
        outputFormat: "stream-json",
        inputFormat: "stream-json",
        fallbackModel: "haiku",
        maxBudgetUsd: 10.5,
        includePartialMessages: true,
        includeHookEvents: true,
        noSessionPersistence: true
      })
    ).toEqual([
      "--print",
      "--fallback-model",
      "haiku",
      "--max-budget-usd",
      "10.5",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--include-hook-events",
      "--no-session-persistence"
    ]);
  });
});

describe("buildClaudeArgs — model + cost knobs", () => {
  test("model: --model <id>", () => {
    expect(buildClaudeArgs({ model: "sonnet" })).toEqual(["--model", "sonnet"]);
    expect(buildClaudeArgs({ model: "claude-opus-4-7" })).toEqual(["--model", "claude-opus-4-7"]);
  });

  test("effort: --effort <level>", () => {
    expect(buildClaudeArgs({ effort: "high" })).toEqual(["--effort", "high"]);
    expect(buildClaudeArgs({ effort: "xhigh" })).toEqual(["--effort", "xhigh"]);
    expect(buildClaudeArgs({ effort: "max" })).toEqual(["--effort", "max"]);
  });
});

describe("buildClaudeArgs — permission + tool surface", () => {
  test("permissionMode: --permission-mode <mode>", () => {
    expect(buildClaudeArgs({ permissionMode: "acceptEdits" })).toEqual([
      "--permission-mode",
      "acceptEdits"
    ]);
    expect(buildClaudeArgs({ permissionMode: "bypassPermissions" })).toEqual([
      "--permission-mode",
      "bypassPermissions"
    ]);
  });

  test("allowedTools / disallowedTools: variadic flag", () => {
    expect(buildClaudeArgs({ allowedTools: ["Bash(git *)", "Edit"] })).toEqual([
      "--allowedTools",
      "Bash(git *)",
      "Edit"
    ]);
    expect(buildClaudeArgs({ disallowedTools: ["Bash(rm *)"] })).toEqual([
      "--disallowedTools",
      "Bash(rm *)"
    ]);
  });

  test("empty arrays: dropped (avoid emitting empty flags)", () => {
    expect(buildClaudeArgs({ allowedTools: [] })).toEqual([]);
    expect(buildClaudeArgs({ disallowedTools: [] })).toEqual([]);
  });
});

describe("buildClaudeArgs — misc + extra", () => {
  test("name: --name <display>", () => {
    expect(buildClaudeArgs({ name: "review-bot" })).toEqual(["--name", "review-bot"]);
  });

  test("addDir: --add-dir <dirs...>", () => {
    expect(buildClaudeArgs({ addDir: ["/x", "/y"] })).toEqual(["--add-dir", "/x", "/y"]);
  });

  test("systemPrompt + appendSystemPrompt: distinct flags", () => {
    expect(buildClaudeArgs({ systemPrompt: "Be terse" })).toEqual(["--system-prompt", "Be terse"]);
    expect(buildClaudeArgs({ appendSystemPrompt: "No emoji" })).toEqual([
      "--append-system-prompt",
      "No emoji"
    ]);
  });

  test("bare: --bare", () => {
    expect(buildClaudeArgs({ bare: true })).toEqual(["--bare"]);
  });

  test("extraArgs: appended verbatim, last", () => {
    expect(buildClaudeArgs({ model: "sonnet", extraArgs: ["--debug", "api"] })).toEqual([
      "--model",
      "sonnet",
      "--debug",
      "api"
    ]);
  });

  test("kitchen sink: stable order with most knobs set", () => {
    expect(
      buildClaudeArgs({
        print: true,
        sessionId: "uuid-1",
        bare: true,
        name: "lab",
        model: "opus",
        effort: "high",
        permissionMode: "default",
        allowedTools: ["Read"],
        addDir: ["/repo"],
        systemPrompt: "go",
        outputFormat: "json",
        extraArgs: ["--verbose"]
      })
    ).toEqual([
      "--print",
      "--session-id",
      "uuid-1",
      "--bare",
      "--name",
      "lab",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "default",
      "--allowedTools",
      "Read",
      "--add-dir",
      "/repo",
      "--system-prompt",
      "go",
      "--output-format",
      "json",
      "--verbose"
    ]);
  });
});
