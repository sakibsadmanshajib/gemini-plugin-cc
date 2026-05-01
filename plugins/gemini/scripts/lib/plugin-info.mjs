/**
 * Plugin identity (name + version) — single source of truth.
 *
 * Resolves the plugin's name/version from the canonical manifest files
 * shipped with the plugin. Fallback chain (first found wins):
 *
 *   1. plugins/gemini/.codex-plugin/plugin.json   — canonical Codex location
 *   2. plugins/gemini/.claude-plugin/plugin.json  — Claude Code location (byte-identical)
 *   3. package.json                                — npm package identity
 *
 * Used by acp-client (clientInfo) and acp-broker (serverInfo) so the ACP
 * handshake reflects the actual installed version rather than a literal
 * string hardcoded into the runtime.
 *
 * Lazy + try/catch so a partial install (e.g. a tarball that excludes
 * .codex-plugin/) degrades to the next candidate rather than crashing
 * at module load.
 */

import fs from "node:fs";

const MANIFEST_CANDIDATES = [
  new URL("../../.codex-plugin/plugin.json", import.meta.url),
  new URL("../../.claude-plugin/plugin.json", import.meta.url),
  new URL("../../../../package.json", import.meta.url)
];

let _cached;

function readFirstAvailable() {
  for (const url of MANIFEST_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(url, "utf8"));
      if (parsed && typeof parsed.name === "string" && typeof parsed.version === "string") {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
      // try next candidate
    }
  }
  // Last-resort sentinel — must not match any real plugin identity.
  return { name: "gemini-plugin-unknown", version: "0.0.0" };
}

/**
 * @returns {{name: string, version: string}} plugin identity
 */
export function getPluginInfo() {
  if (_cached === undefined) {
    _cached = readFirstAvailable();
  }
  return _cached;
}

/**
 * Test-only reset hook so tests can re-evaluate after manifest changes.
 */
export function _resetPluginInfoCacheForTests() {
  _cached = undefined;
}
