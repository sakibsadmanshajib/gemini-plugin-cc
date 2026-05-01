/**
 * Plugin identity (name + version) — single source of truth.
 *
 * Resolves the plugin's name/version from the canonical manifest files
 * shipped with the plugin. Fallback chain (first found wins):
 *
 *   1. plugins/gemini/.codex-plugin/plugin.json   — canonical Codex location
 *   2. plugins/gemini/.claude-plugin/plugin.json  — Claude Code location (byte-identical)
 *
 * Used by acp-client (clientInfo) and acp-broker (serverInfo) so the ACP
 * handshake reflects the actual installed version rather than a literal
 * string hardcoded into the runtime.
 *
 * Lazy + try/catch so a partial install (e.g. a tarball that excludes
 * .codex-plugin/) degrades to the next candidate rather than crashing
 * at module load.
 *
 * `package.json` is intentionally NOT in the fallback chain. Its `name`
 * field (`"gemini-plugin-cc"`, the npm package name) does NOT match the
 * plugin's `name` field (`"gemini"`, the plugin identifier used by Claude
 * Code/Codex marketplaces). Falling back to it would silently change the
 * ACP wire identity from `"gemini"` to `"gemini-plugin-cc"` — a regression
 * for any consumer matching on identity. Since the two manifest files are
 * byte-identical (verified by `tests/install.test.mjs`), losing both at
 * once would be a deeply broken install for which a sentinel is the right
 * signal.
 */

import fs from "node:fs";

const MANIFEST_CANDIDATES = [
  new URL("../../.codex-plugin/plugin.json", import.meta.url),
  new URL("../../.claude-plugin/plugin.json", import.meta.url)
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
  // Reaching this means BOTH manifest files are missing or malformed,
  // which indicates a broken install. The sentinel surfaces the problem
  // in ACP `clientInfo`/`serverInfo` rather than silently masking it.
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
