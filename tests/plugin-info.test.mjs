/**
 * plugin-info.mjs — single source of truth for plugin name + version.
 *
 * Verifies that getPluginInfo() returns the values from one of the canonical
 * manifest files, AND that the result agrees across .codex-plugin/.claude-plugin/
 * package.json (no drift between the three identities).
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

test("plugin-info: getPluginInfo returns a non-empty name and version", async () => {
  const { getPluginInfo, _resetPluginInfoCacheForTests } = await import(
    path.join(PLUGIN_ROOT, "plugins", "gemini", "scripts", "lib", "plugin-info.mjs")
  );
  _resetPluginInfoCacheForTests();
  const info = getPluginInfo();
  assert.equal(typeof info.name, "string");
  assert.equal(typeof info.version, "string");
  assert.ok(info.name.length > 0, "name must be non-empty");
  assert.ok(info.version.length > 0, "version must be non-empty");
  assert.notEqual(info.name, "gemini-plugin-unknown",
    "name must come from a real manifest, not the last-resort sentinel");
});

test("plugin-info: name and version agree across .codex-plugin and .claude-plugin manifests", () => {
  const codex = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, "plugins", "gemini", ".codex-plugin", "plugin.json"), "utf8"));
  const claude = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, "plugins", "gemini", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(codex.name, claude.name, "name must match across host manifests");
  assert.equal(codex.version, claude.version, "version must match across host manifests");
});

test("plugin-info: returns identity matching the canonical Codex manifest", async () => {
  const { getPluginInfo, _resetPluginInfoCacheForTests } = await import(
    path.join(PLUGIN_ROOT, "plugins", "gemini", "scripts", "lib", "plugin-info.mjs")
  );
  _resetPluginInfoCacheForTests();
  const info = getPluginInfo();
  const codex = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, "plugins", "gemini", ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(info.name, codex.name);
  assert.equal(info.version, codex.version);
});
