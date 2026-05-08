/**
 * Marketplace structural test for the multi-plugin layout.
 *
 * Both `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`
 * must list ALL three plugins (gemini, claude, codex) with the correct
 * per-host source shape:
 *
 *   - Claude Code: `source` is a string path, e.g. `"./plugins/<name>"`
 *   - Codex CLI:   `source` is an object `{source: "local", path: "..."}`
 *
 * Existing `tests/integration/install.test.mjs` already asserts the
 * shape of EACH entry; this test additionally asserts the SET — i.e.
 * that all three plugin names are present in both descriptors and that
 * the cross-host name agreement holds.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ALL_BACKEND_NAMES } from "#lib/backends/names.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const claudeMarketplace = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".claude-plugin/marketplace.json"), "utf8")
);
const codexMarketplace = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".agents/plugins/marketplace.json"), "utf8")
);

describe("marketplace lists all three plugins", () => {
  test("Claude marketplace lists gemini, claude, codex", () => {
    const names = claudeMarketplace.plugins.map((p) => p.name);
    for (const backend of ALL_BACKEND_NAMES) {
      expect(names).toContain(backend);
    }
  });

  test("Codex marketplace lists gemini, claude, codex", () => {
    const names = codexMarketplace.plugins.map((p) => p.name);
    for (const backend of ALL_BACKEND_NAMES) {
      expect(names).toContain(backend);
    }
  });

  test("plugin name set agrees across hosts", () => {
    const claudeNames = new Set(claudeMarketplace.plugins.map((p) => p.name));
    const codexNames = new Set(codexMarketplace.plugins.map((p) => p.name));
    expect([...claudeNames].sort()).toEqual([...codexNames].sort());
  });
});

describe("per-host source shape", () => {
  test("Claude entries use string source paths", () => {
    for (const plugin of claudeMarketplace.plugins) {
      expect(typeof plugin.source).toBe("string");
      expect(plugin.source.startsWith("./plugins/")).toBe(true);
      expect(plugin.source).toBe(`./plugins/${plugin.name}`);
    }
  });

  test("Codex entries use object source descriptors", () => {
    for (const plugin of codexMarketplace.plugins) {
      expect(typeof plugin.source).toBe("object");
      expect(plugin.source.source).toBe("local");
      expect(plugin.source.path).toBe(`./plugins/${plugin.name}`);
    }
  });

  test("each Codex plugin entry declares policy + category + interface", () => {
    for (const plugin of codexMarketplace.plugins) {
      expect(plugin.policy?.installation).toBe("AVAILABLE");
      expect(plugin.policy?.authentication).toBe("ON_INSTALL");
      expect(typeof plugin.category).toBe("string");
      expect(typeof plugin.interface?.displayName).toBe("string");
    }
  });
});

describe("each marketplace entry's source path resolves to an existing plugin dir", () => {
  test("Claude entries point at existing plugin directories", () => {
    for (const plugin of claudeMarketplace.plugins) {
      const dir = path.join(ROOT, plugin.source);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, ".claude-plugin/plugin.json"))).toBe(true);
    }
  });

  test("Codex entries point at existing plugin directories", () => {
    for (const plugin of codexMarketplace.plugins) {
      const dir = path.join(ROOT, plugin.source.path);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, ".codex-plugin/plugin.json"))).toBe(true);
    }
  });
});
