/**
 * Broker probe — detect a running `gemini --acp` broker for a given cwd.
 *
 * The legacy `/gemini:*` slash commands keep a long-running `gemini --acp`
 * resident across a Claude Code session. The broker writes a
 * `broker-session.json` file to the cwd's state dir, then accepts ACP
 * JSON-RPC over a Unix socket. When that broker is alive, cross-driver
 * `gemini-prompt` calls can connect to it instead of cold-spawning a
 * fresh `gemini -p` — turning a ~5s call into a ~1s call.
 *
 * This module is the lib-level probe that the dispatcher uses. It
 * deliberately does NOT depend on `plugins/gemini/scripts/lib/` (the
 * legacy plugin tree) — the state-dir resolution is mirrored here so
 * the probe ships in the public lib surface.
 *
 * Probe semantics (must all pass):
 *   1. broker-session.json exists at the resolved state path
 *   2. Its `endpoint` field parses to a valid broker endpoint
 *   3. Its `pid` is alive (`process.kill(pid, 0)` doesn't throw)
 *   4. The pid is owned by the current uid (cross-uid hand-off refused)
 *   5. The socket file exists AND is owned by the current uid
 *
 * Any failure → return null. The dispatcher falls back to the cold-start
 * runner when null. The probe is read-only — it never deletes stale files
 * or touches process state.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const CLAUDE_HOST_SIGNAL_ENV = "CLAUDE_ENV_FILE";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion");
const BROKER_SESSION_FILE = "broker-session.json";

/**
 * @typedef {{
 *   endpoint: string,
 *   pidFile?: string,
 *   logFile?: string,
 *   sessionDir?: string,
 *   pid: number | null
 * }} BrokerSession
 */

/**
 * @returns {boolean}
 */
function isClaudeHost(env = process.env) {
  const envFile = env[CLAUDE_HOST_SIGNAL_ENV];
  if (!envFile) return false;
  try {
    return fs.statSync(envFile).isFile();
  } catch {
    return false;
  }
}

function slugify(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function hashPath(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Resolve the broker-state directory for a given cwd. Mirrors
 * `plugins/gemini/scripts/lib/state.mjs::resolveStateDir` so the lib-
 * level probe doesn't reach back into the plugin tree.
 *
 * Claude Code path: when `CLAUDE_ENV_FILE` points at a real file
 * AND `CLAUDE_PLUGIN_DATA` is set, use `<plugin-data>/state/<slug>-<hash>/`.
 * Codex / standalone path: `$TMPDIR/gemini-companion/<slug>-<hash>/`.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveBrokerStateDir(cwd, env = process.env) {
  const root =
    isClaudeHost(env) && env[PLUGIN_DATA_ENV]
      ? path.join(env[PLUGIN_DATA_ENV], "state")
      : FALLBACK_STATE_ROOT_DIR;
  const slug = slugify(path.basename(cwd));
  const hash = hashPath(cwd);
  return path.join(root, `${slug}-${hash}`);
}

/**
 * Resolve the broker session JSON file path for a given cwd.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveBrokerSessionFile(cwd, env = process.env) {
  return path.join(resolveBrokerStateDir(cwd, env), BROKER_SESSION_FILE);
}

/**
 * Read the broker-session.json file as written by the broker, OR null
 * when missing or malformed. Pure read; no side effects.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BrokerSession | null}
 */
export function loadBrokerSession(cwd, env = process.env) {
  const file = resolveBrokerSessionFile(cwd, env);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.endpoint !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Is `pid` a process we can signal AND owned by the current uid?
 *
 * `process.kill(pid, 0)` throws ESRCH if the pid is dead, EPERM if it's
 * alive but owned by a different uid. We treat EPERM as "stale from
 * our perspective" (we can't safely connect to a broker we don't own).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidLiveAndOwned(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Parse a broker endpoint string. The legacy broker writes
 * `unix:<path>` on POSIX and `pipe:\\\\.\\pipe\\<name>` on Windows.
 * We inline this small parser here rather than reaching into the
 * plugin tree, so lib/ stays self-contained.
 *
 * @param {string} endpoint
 * @returns {{ kind: "unix" | "pipe", path: string } | null}
 */
function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) return null;
  if (endpoint.startsWith("unix:")) {
    return { kind: "unix", path: endpoint.slice("unix:".length) };
  }
  if (endpoint.startsWith("pipe:")) {
    return { kind: "pipe", path: endpoint.slice("pipe:".length) };
  }
  return null;
}

/**
 * Is the socket file at the broker endpoint owned by the current uid?
 *
 * Only unix-socket endpoints are checked. Named pipes on Windows have
 * their own ACL model that this probe does not validate; on Windows we
 * conservatively trust pipe-owner-equals-creator.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
function isSocketOwned(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  if (!target) return false;
  if (target.kind !== "unix") {
    // Windows named pipes: defer to OS ACL. Best-effort accept.
    return process.platform === "win32";
  }
  try {
    const stat = fs.statSync(target.path);
    const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
    return myUid !== -1 && stat.uid === myUid;
  } catch {
    return false;
  }
}

/**
 * Probe for a healthy broker session for `cwd`. Returns the endpoint
 * string when ALL of the gating checks pass; null otherwise.
 *
 *   1. broker-session.json exists and parses
 *   2. session.endpoint is set
 *   3. session.pid is alive AND owned by current uid
 *   4. socket file at endpoint exists AND is owned by current uid
 *
 * Probe is non-destructive: stale state files are NOT deleted by this
 * function. The dispatcher's fallback path runs `runGeminiPrint` (cold
 * start) when probe returns null; cleanup is the broker lifecycle's job.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} broker endpoint, or null when no usable broker found
 */
export function findActiveBroker(cwd, env = process.env) {
  const session = loadBrokerSession(cwd, env);
  if (!session) return null;
  if (typeof session.endpoint !== "string" || session.endpoint === "") return null;
  if (typeof session.pid !== "number") return null;
  if (!isPidLiveAndOwned(session.pid)) return null;
  if (!isSocketOwned(session.endpoint)) return null;
  return session.endpoint;
}
