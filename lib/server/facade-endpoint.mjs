/**
 * Facade endpoint manifest — record where a running
 * `artagon-openai-server` is listening so other tools (the dispatcher's
 * `ARTAGON_USE_FACADE=1` path, `artagon-agent --via-facade`) can find it
 * without prior knowledge of the port.
 *
 * Path: `$XDG_STATE_HOME/artagon-agent-cli-plugin/facade-endpoint.json`
 *   (default `~/.local/state/artagon-agent-cli-plugin/facade-endpoint.json`)
 *
 * Mode: 0o600 file, 0o700 parent dir, owned by the running uid. The
 * manifest contains no secrets — only the host/port + pid + optional
 * `retrieveCommand` pointing at where to fetch the auto-key. The key
 * itself stays in Keychain or its own 0o600 file (see
 * `lib/server/api-key-store.mjs`).
 *
 * Lifecycle: written on `facade.listen()`, deleted on `facade.close()`.
 * Stale-detection contract: readers MUST verify `pid` is alive AND
 * matches the current uid; mismatched ownership returns null and the
 * caller falls back to a non-facade path.
 *
 * Format:
 *   {
 *     "host":  "127.0.0.1",
 *     "port":  3000,
 *     "pid":   12345,
 *     "startedAt": "2026-05-09T16:21:33.001Z",
 *     "autoKey": null | { "store": "keychain"|"file", "retrieveCommand": "..." }
 *   }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE_DIR = "artagon-agent-cli-plugin";
const MANIFEST_NAME = "facade-endpoint.json";

/**
 * @typedef {{
 *   host: string,
 *   port: number,
 *   pid: number,
 *   startedAt: string,
 *   autoKey?: { store: "keychain" | "file", retrieveCommand: string } | null
 * }} FacadeManifest
 */

/**
 * Resolve the manifest path. Honors `$XDG_STATE_HOME` → falls back to
 * `~/.local/state`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ dir: string, file: string }}
 */
export function manifestPaths(env = process.env) {
  const xdg = env.XDG_STATE_HOME?.trim();
  const root = xdg ? xdg : path.join(os.homedir(), ".local", "state");
  const dir = path.join(root, SERVICE_DIR);
  const file = path.join(dir, MANIFEST_NAME);
  return { dir, file };
}

/**
 * Write the manifest atomically (temp + rename) with mode 0o600 under a
 * 0o700 directory. Idempotent; any existing manifest is replaced.
 *
 * @param {Omit<FacadeManifest, "startedAt">} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {FacadeManifest}
 */
export function writeManifest(entry, env = process.env) {
  const { dir, file } = manifestPaths(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  /** @type {FacadeManifest} */
  const full = {
    host: entry.host,
    port: entry.port,
    pid: entry.pid,
    startedAt: new Date().toISOString(),
    autoKey: entry.autoKey ?? null
  };
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return full;
}

/**
 * Delete the manifest. Best-effort — missing file is not an error
 * (server may have been killed before listen completed).
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function deleteManifest(env = process.env) {
  const { file } = manifestPaths(env);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      // Don't crash a shutting-down server on permissions etc.
      // Log via stderr but continue.
      process.stderr.write(`[facade-endpoint] delete failed: ${String(err)}\n`);
    }
  }
}

/**
 * Is `pid` a live process AND owned by the current uid?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidLiveAndOwned(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the manifest file owned by the current uid?
 *
 * @param {string} file
 * @returns {boolean}
 */
function isManifestOwned(file) {
  try {
    const stat = fs.statSync(file);
    const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
    return myUid !== -1 && stat.uid === myUid;
  } catch {
    return false;
  }
}

/**
 * Read the current facade manifest, returning null when no usable
 * facade is running. ALL of these gates must pass:
 *
 *   1. file exists and parses as JSON
 *   2. shape has `host`, `port`, `pid`
 *   3. file is owned by current uid (cross-uid hand-off refused)
 *   4. pid is alive (process.kill(pid, 0) doesn't throw)
 *
 * Any failure → null. Caller falls back to non-facade path.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {FacadeManifest | null}
 */
export function readManifest(env = process.env) {
  const { file } = manifestPaths(env);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!isManifestOwned(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.host !== "string" || parsed.host === "") return null;
  if (typeof parsed.port !== "number" || !Number.isInteger(parsed.port)) return null;
  if (typeof parsed.pid !== "number" || !isPidLiveAndOwned(parsed.pid)) return null;
  return /** @type {FacadeManifest} */ (parsed);
}
