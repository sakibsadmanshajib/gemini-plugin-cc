/**
 * Argv-emission tests for backend CLI argument builders.
 *
 * These functions are the boundary between the typed BackendConfig surface
 * the rest of the runtime sees and the CLI flag taxonomy each backend
 * actually consumes (per docs/cli-options-research.md). The tests assert:
 *   - the canonical "no options" form matches what the runtime spawns today
 *   - each option emits the documented flag
 *   - mutual-exclusion rules pick the explicit option
 *   - repeatable flags emit one pair per array entry
 *   - `extraArgs` always lands at the end (so callers can override anything)
 *
 * No subprocess is spawned — these are pure-function tests.
 */

import { describe, expect, test } from "vitest";

import { buildCodexArgs } from "#lib/backends/codex.mjs";
import { buildGeminiArgs } from "#lib/backends/gemini.mjs";

describe("buildGeminiArgs", () => {
  test("default: emits only --acp", () => {
    expect(buildGeminiArgs()).toEqual(["--acp"]);
    expect(buildGeminiArgs({})).toEqual(["--acp"]);
  });

  test("yolo: --yolo after --acp", () => {
    expect(buildGeminiArgs({ yolo: true })).toEqual(["--acp", "--yolo"]);
  });

  test("approvalMode: --approval-mode <mode>", () => {
    expect(buildGeminiArgs({ approvalMode: "auto_edit" })).toEqual([
      "--acp",
      "--approval-mode",
      "auto_edit"
    ]);
    expect(buildGeminiArgs({ approvalMode: "plan" })).toEqual(["--acp", "--approval-mode", "plan"]);
  });

  test("explicit approvalMode wins over yolo", () => {
    expect(buildGeminiArgs({ approvalMode: "plan", yolo: true })).toEqual([
      "--acp",
      "--approval-mode",
      "plan"
    ]);
  });

  test("worktree: --worktree <name>; empty string dropped", () => {
    expect(buildGeminiArgs({ worktree: "review-branch" })).toEqual([
      "--acp",
      "--worktree",
      "review-branch"
    ]);
    expect(buildGeminiArgs({ worktree: "" })).toEqual(["--acp"]);
  });

  test("sandbox: --sandbox flag (boolean)", () => {
    expect(buildGeminiArgs({ sandbox: true })).toEqual(["--acp", "--sandbox"]);
    expect(buildGeminiArgs({ sandbox: false })).toEqual(["--acp"]);
  });

  test("model: --model <id>", () => {
    expect(buildGeminiArgs({ model: "gemini-3.1-pro-preview" })).toEqual([
      "--acp",
      "--model",
      "gemini-3.1-pro-preview"
    ]);
  });

  test("includeDirectories: comma-joined", () => {
    expect(buildGeminiArgs({ includeDirectories: ["/a", "/b/c", "/d e"] })).toEqual([
      "--acp",
      "--include-directories",
      "/a,/b/c,/d e"
    ]);
    expect(buildGeminiArgs({ includeDirectories: [] })).toEqual(["--acp"]);
  });

  test("policyFiles: one --policy pair per entry", () => {
    expect(buildGeminiArgs({ policyFiles: ["a.md", "b.md"] })).toEqual([
      "--acp",
      "--policy",
      "a.md",
      "--policy",
      "b.md"
    ]);
  });

  test("adminPolicyFiles: one --admin-policy pair per entry", () => {
    expect(buildGeminiArgs({ adminPolicyFiles: ["root.md"] })).toEqual([
      "--acp",
      "--admin-policy",
      "root.md"
    ]);
  });

  test("extraArgs lands last (caller can pass anything not yet declared)", () => {
    expect(
      buildGeminiArgs({
        yolo: true,
        extraArgs: ["--screen-reader", "--debug"]
      })
    ).toEqual(["--acp", "--yolo", "--screen-reader", "--debug"]);
  });

  test("kitchen sink: stable order across all knobs", () => {
    expect(
      buildGeminiArgs({
        approvalMode: "auto_edit",
        worktree: "wt",
        sandbox: true,
        model: "gemini-3-flash-preview",
        includeDirectories: ["/x"],
        policyFiles: ["p.md"],
        adminPolicyFiles: ["a.md"],
        extraArgs: ["--debug"]
      })
    ).toEqual([
      "--acp",
      "--approval-mode",
      "auto_edit",
      "--worktree",
      "wt",
      "--sandbox",
      "--model",
      "gemini-3-flash-preview",
      "--include-directories",
      "/x",
      "--policy",
      "p.md",
      "--admin-policy",
      "a.md",
      "--debug"
    ]);
  });
});

describe("buildCodexArgs", () => {
  test("default: emits only acp", () => {
    expect(buildCodexArgs({})).toEqual(["acp"]);
  });

  test("effort: --effort <level>", () => {
    expect(buildCodexArgs({ effort: "high" })).toEqual(["acp", "--effort", "high"]);
    expect(buildCodexArgs({ effort: "max" })).toEqual(["acp", "--effort", "max"]);
  });

  test("model: --model <id>", () => {
    expect(buildCodexArgs({ model: "gpt-5-codex" })).toEqual(["acp", "--model", "gpt-5-codex"]);
  });

  test("quiet: --quiet flag", () => {
    expect(buildCodexArgs({ quiet: true })).toEqual(["acp", "--quiet"]);
    expect(buildCodexArgs({ quiet: false })).toEqual(["acp"]);
  });

  test("extraArgs lands last", () => {
    expect(buildCodexArgs({ effort: "low", extraArgs: ["-c", "model=o3"] })).toEqual([
      "acp",
      "--effort",
      "low",
      "-c",
      "model=o3"
    ]);
  });

  test("kitchen sink: stable order across all knobs", () => {
    expect(
      buildCodexArgs({
        effort: "high",
        model: "spark",
        quiet: true,
        extraArgs: ["--profile", "dev"]
      })
    ).toEqual(["acp", "--effort", "high", "--model", "spark", "--quiet", "--profile", "dev"]);
  });
});
