/**
 * Shared canonical paths, env-var names, and string constants used across
 * the plugin's install/integration tests. Single source of truth so tests
 * don't drift from the runtime.
 *
 * If a test asserts against a path or env var, it MUST come from here.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, "..");

// ─── Plugin source-tree layout (relative to PLUGIN_ROOT) ──────────────────

export const PLUGIN_SOURCE_DIR_RELATIVE = path.join("plugins", "gemini");

// Canonical Codex manifest dir (per OpenAI docs at developers.openai.com/codex/plugins/build).
export const CODEX_PLUGIN_DIR_NAME = ".codex-plugin";
// Claude Code manifest dir (Claude Code's documented dir name).
export const CLAUDE_PLUGIN_DIR_NAME = ".claude-plugin";
// Manifest filename used by both hosts inside their respective dirs.
export const PLUGIN_MANIFEST_FILENAME = "plugin.json";

// Marketplace manifest filename, used at multiple locations.
export const MARKETPLACE_MANIFEST_FILENAME = "marketplace.json";

// Codex's documented marketplace location: `<repo-root>/.agents/plugins/marketplace.json`.
export const CODEX_MARKETPLACE_DIR_RELATIVE = path.join(".agents", "plugins");

// Claude Code's marketplace location for this repo: `.claude-plugin/marketplace.json`.
// Same dir as the Claude plugin manifest by convention.
export const CLAUDE_MARKETPLACE_DIR_RELATIVE = CLAUDE_PLUGIN_DIR_NAME;

// Install documentation lives at `docs/INSTALL.md` (host-agnostic, covers both Claude and Codex).
export const INSTALL_DOC_RELATIVE = path.join("docs", "INSTALL.md");

// Codex implicit-invocation interface file (auto-discovered by Codex CLI inside the plugin source dir).
export const AGENTS_DIR_NAME = "agents";
export const OPENAI_AGENT_FILENAME = "openai.yaml";

// Skill manifest filename. Codex looks for it inside the plugin source dir.
export const SKILL_MANIFEST_FILENAME = "SKILL.md";

// Runtime entry points the plugin manifest implicitly references.
export const RUNTIME_SCRIPT_RELATIVE = path.join("scripts", "gemini-companion.mjs");
export const BROKER_SCRIPT_RELATIVE = path.join("scripts", "acp-broker.mjs");
export const HOOKS_FILE_RELATIVE = path.join("hooks", "hooks.json");

// Helper: absolute path inside the plugin source dir.
export function pluginSourcePath(...segments) {
  return path.join(PLUGIN_ROOT, PLUGIN_SOURCE_DIR_RELATIVE, ...segments);
}

// Helper: absolute path to a host-specific manifest.
export function manifestPath(host /* "codex" | "claude" */) {
  const dir = host === "codex" ? CODEX_PLUGIN_DIR_NAME : CLAUDE_PLUGIN_DIR_NAME;
  return pluginSourcePath(dir, PLUGIN_MANIFEST_FILENAME);
}

// ─── Env var names that gate dual-host behavior ───────────────────────────
// These mirror the runtime's state.mjs constants. Tests assert against them
// and the runtime reads them; both must use these symbols, not literals.

// Set by Claude Code's session lifecycle hook; points at a real session.env file.
// The runtime treats this as the unmistakable "Claude is the host" signal.
export const CLAUDE_HOST_SIGNAL_ENV = "CLAUDE_ENV_FILE";

// Set by Claude Code (via plugin marketplace) to the per-plugin data dir.
// A user might also export this in their shell rc — by itself it does NOT
// signal Claude. The combination CLAUDE_HOST_SIGNAL_ENV + CLAUDE_PLUGIN_DATA_ENV does.
export const CLAUDE_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

// Set by Claude Code's session lifecycle hook; scopes job-status filtering
// to the current session. Codex never sets this.
export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";

// ─── Filenames the runtime writes inside the state dir ────────────────────

export const SESSION_ENV_FILENAME = "session.env";   // Claude Code writes this
export const STATE_DIR_NAME = "state";               // <CLAUDE_PLUGIN_DATA>/state/...
export const FALLBACK_STATE_ROOT_NAME = "gemini-companion"; // <TMPDIR>/gemini-companion/...
export const ACP_SESSION_DIR_NAME = "acp-session";
export const BROKER_SESSION_FILENAME = "broker-session.json";
export const BROKER_SOCKET_FILENAME = "broker.sock";
export const BROKER_PID_FILENAME = "broker.pid";
export const BROKER_LOG_FILENAME = "broker.log";

// ─── Test temp-dir prefixes (descriptive, plugin-named, not branch-named) ─

export const TEMP_PREFIX_CLAUDE_ENV = "gemini-claude-env-";
export const TEMP_PREFIX_WORKSPACE = "gemini-workspace-";
export const TEMP_PREFIX_PLUGIN_DATA = "gemini-plugindata-";
export const TEMP_PREFIX_REALPATH = "gemini-realpath-";
export const TEMP_PREFIX_SYMPARENT = "gemini-symparent-";
