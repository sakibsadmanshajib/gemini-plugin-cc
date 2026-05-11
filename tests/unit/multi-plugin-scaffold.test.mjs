/**
 * Structural sanity for the multi-plugin scaffold.
 *
 * Per the cross-pollination model: each plugin is named for its HOST
 * (not for what it drives) and provides commands that drive the OTHER
 * two backends via the stateless runners + dispatcher.
 *
 * This test verifies the manifest shape, byte-equivalence between the
 * Claude-host and Codex-host manifests of each plugin (per project
 * convention; see plugins/gemini's existing dual manifests), and that
 * each new plugin's slash-command shell calls runStatelessTurn with a
 * valid BackendName from the enum.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { BACKEND_NAMES, isBackendName } from "#lib/backends/names.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

/** @param {string} relPath */
function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

/** @param {string} relPath */
function readText(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("plugins/claude (installed in Claude Code)", () => {
  test("manifests exist for both hosts", () => {
    expect(fs.existsSync(path.join(ROOT, "plugins/claude/.claude-plugin/plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "plugins/claude/.codex-plugin/plugin.json"))).toBe(true);
  });

  test("manifests are byte-equivalent across hosts", () => {
    const claudeHost = readText("plugins/claude/.claude-plugin/plugin.json");
    const codexHost = readText("plugins/claude/.codex-plugin/plugin.json");
    expect(claudeHost).toBe(codexHost);
  });

  test('manifest declares name="claude" + valid version + description', () => {
    const m = readJson("plugins/claude/.claude-plugin/plugin.json");
    expect(m.name).toBe(BACKEND_NAMES.CLAUDE);
    expect(typeof m.version).toBe("string");
    expect(m.version.length).toBeGreaterThan(0);
    expect(typeof m.description).toBe("string");
    expect(m.description.length).toBeGreaterThan(0);
  });

  test("commands/codex-prompt.md drives Codex (per cross-pollination spec)", () => {
    const cmd = readText("plugins/claude/commands/codex-prompt.md");
    expect(cmd).toMatch(/codex/i);
    expect(cmd).toMatch(/scripts\/codex-prompt\.mjs/);
  });

  test("commands/gemini-prompt.md drives Gemini (per cross-pollination spec)", () => {
    const cmd = readText("plugins/claude/commands/gemini-prompt.md");
    expect(cmd).toMatch(/gemini/i);
    expect(cmd).toMatch(/scripts\/gemini-prompt\.mjs/);
  });

  test("scripts/codex-prompt.mjs drives via runSlashCommandScript(CODEX)", () => {
    const script = readText("plugins/claude/scripts/codex-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.CODEX/);
    // Must NOT reference its own host backend name (claude installed in
    // Claude Code drives codex/gemini, not claude itself).
    expect(script).not.toMatch(/BACKEND_NAMES\.CLAUDE/);
  });

  test("scripts/gemini-prompt.mjs drives via runSlashCommandScript(GEMINI) — never CLAUDE", () => {
    const script = readText("plugins/claude/scripts/gemini-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.GEMINI/);
    expect(script).not.toMatch(/BACKEND_NAMES\.CLAUDE/);
  });
});

describe("plugins/codex (installed in Codex CLI)", () => {
  test("manifests exist for both hosts", () => {
    expect(fs.existsSync(path.join(ROOT, "plugins/codex/.claude-plugin/plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "plugins/codex/.codex-plugin/plugin.json"))).toBe(true);
  });

  test("manifests are byte-equivalent across hosts", () => {
    const claudeHost = readText("plugins/codex/.claude-plugin/plugin.json");
    const codexHost = readText("plugins/codex/.codex-plugin/plugin.json");
    expect(claudeHost).toBe(codexHost);
  });

  test('manifest declares name="codex" + valid version + description', () => {
    const m = readJson("plugins/codex/.claude-plugin/plugin.json");
    expect(m.name).toBe(BACKEND_NAMES.CODEX);
    expect(typeof m.version).toBe("string");
    expect(typeof m.description).toBe("string");
  });

  test("commands/claude-prompt.md drives Claude (per cross-pollination spec)", () => {
    const cmd = readText("plugins/codex/commands/claude-prompt.md");
    expect(cmd).toMatch(/claude/i);
    expect(cmd).toMatch(/scripts\/claude-prompt\.mjs/);
  });

  test("commands/gemini-prompt.md drives Gemini (per cross-pollination spec)", () => {
    const cmd = readText("plugins/codex/commands/gemini-prompt.md");
    expect(cmd).toMatch(/gemini/i);
    expect(cmd).toMatch(/scripts\/gemini-prompt\.mjs/);
  });

  test("scripts/claude-prompt.mjs drives via runSlashCommandScript(CLAUDE)", () => {
    const script = readText("plugins/codex/scripts/claude-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.CLAUDE/);
    expect(script).not.toMatch(/BACKEND_NAMES\.CODEX/);
  });

  test("scripts/gemini-prompt.mjs drives via runSlashCommandScript(GEMINI) — never CODEX", () => {
    const script = readText("plugins/codex/scripts/gemini-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.GEMINI/);
    expect(script).not.toMatch(/BACKEND_NAMES\.CODEX/);
  });
});

describe("Cross-plugin invariants", () => {
  test("each plugin's manifest name is a valid BackendName", () => {
    for (const slug of [BACKEND_NAMES.CLAUDE, BACKEND_NAMES.CODEX]) {
      const m = readJson(`plugins/${slug}/.claude-plugin/plugin.json`);
      expect(isBackendName(m.name)).toBe(true);
    }
  });

  test("plugin slug matches manifest name", () => {
    for (const slug of [BACKEND_NAMES.CLAUDE, BACKEND_NAMES.CODEX]) {
      const m = readJson(`plugins/${slug}/.claude-plugin/plugin.json`);
      expect(m.name).toBe(slug);
    }
  });
});

describe("plugins/gemini cross-pollination commands", () => {
  // The legacy plugins/gemini/ predates the cross-pollination model and
  // continues to ship its original `/gemini:*` commands. The cross-driving
  // companions (`/claude:prompt` + `/codex:prompt`) sit alongside them so
  // the host's plugin offers commands for the OTHER two backends in
  // addition to its own legacy commands.
  test("commands/claude-prompt.md drives Claude", () => {
    const cmd = readText("plugins/gemini/commands/claude-prompt.md");
    expect(cmd).toMatch(/claude/i);
    expect(cmd).toMatch(/scripts\/claude-prompt\.mjs/);
  });

  test("commands/codex-prompt.md drives Codex", () => {
    const cmd = readText("plugins/gemini/commands/codex-prompt.md");
    expect(cmd).toMatch(/codex/i);
    expect(cmd).toMatch(/scripts\/codex-prompt\.mjs/);
  });

  test("scripts/claude-prompt.mjs drives via runSlashCommandScript(CLAUDE) — never GEMINI", () => {
    const script = readText("plugins/gemini/scripts/claude-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.CLAUDE/);
    // The cross-pollination invariant: must NOT reference its own host.
    expect(script).not.toMatch(/BACKEND_NAMES\.GEMINI/);
  });

  test("scripts/codex-prompt.mjs drives via runSlashCommandScript(CODEX) — never GEMINI", () => {
    const script = readText("plugins/gemini/scripts/codex-prompt.mjs");
    expect(script).toMatch(/runSlashCommandScript/);
    expect(script).toMatch(/BACKEND_NAMES\.CODEX/);
    expect(script).not.toMatch(/BACKEND_NAMES\.GEMINI/);
  });
});
