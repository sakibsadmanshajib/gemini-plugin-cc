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

import { randomBytes } from "node:crypto";
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
 * S1 (round-13) — closes the M2 TOCTOU race: atomically claim the
 * manifest via rename, verify it matches the expected pid+port, and
 * either commit the delete (tombstone unlinked) or restore the file
 * if we tombstoned a different daemon's fresher manifest.
 *
 * The TOCTOU race the previous K2/M2 implementation had:
 *   1. Caller hits ECONNREFUSED with captured manifest M1 (pid+port)
 *   2. readManifest still returns M1 from disk
 *   3. → another process spawns a new daemon and atomically writes M2
 *   4. Caller's deleteManifest unlinks M2 — wiping a healthy daemon's
 *      discovery file
 *
 * With this function:
 *   - `rename(manifest, tombstone)` atomically claims whatever's at
 *     the path right now. Only one process can win.
 *   - We then read the tombstone and compare against the expected
 *     pid+port the caller captured.
 *   - On match: unlink the tombstone. The wipe is committed.
 *   - On mismatch: someone wrote a fresher manifest into the path
 *     between our capture and our rename. Restore the tombstoned
 *     file via `link()` (atomic-or-fail: succeeds only when the
 *     target path is empty), then unlink the tombstone copy.
 *   - On link-EEXIST (yet another even-fresher manifest is now at
 *     the path): give up on restore, drop the tombstone. The
 *     freshest manifest wins; the daemon we tombstoned loses its
 *     discovery file but the operator has the newest one.
 *
 * Returns `{ committed }` so the caller can shape an error message
 * with the correct outcome.
 *
 * @param {{ pid: number, port: number }} expected
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ committed: boolean, reason?: string }}
 *   `committed: true` → manifest matched expectation and was deleted.
 *   `committed: false` → manifest didn't match; reason describes why.
 */
export function compareAndDeleteManifest(expected, env = process.env) {
  const { file } = manifestPaths(env);
  // Per-process unique tombstone name — `randomBytes` keeps two
  // concurrent processes' tombstones from colliding even within the
  // same pid (which can happen with fork-spawned tests).
  const tombstone = `${file}.tomb.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    fs.renameSync(file, tombstone);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === "ENOENT") {
      // Someone else already deleted the manifest. The wipe intent is
      // satisfied; just report it.
      return { committed: false, reason: "manifest_already_gone" };
    }
    // Permissions / disk-full / other unexpected error.
    return {
      committed: false,
      reason: `rename_failed:${err instanceof Error ? err.message : String(err)}`
    };
  }

  // We now own the tombstone file. Verify its contents match the
  // caller's expectation BEFORE committing the delete. Use the same
  // ownership + JSON-parse gates as readManifest.
  if (!isManifestOwned(tombstone)) {
    // Foreign-uid file — best-effort cleanup, refuse to delete.
    try {
      fs.unlinkSync(tombstone);
    } catch {
      /* best-effort */
    }
    return { committed: false, reason: "ownership_mismatch" };
  }
  /** @type {FacadeManifest | null} */
  let tombManifest = null;
  try {
    const text = fs.readFileSync(tombstone, "utf8");
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.pid === "number"
    ) {
      tombManifest = /** @type {FacadeManifest} */ (parsed);
    }
  } catch {
    // malformed tombstone — same as mismatch
  }

  if (tombManifest && tombManifest.pid === expected.pid && tombManifest.port === expected.port) {
    // Match: commit the delete by unlinking the tombstone.
    try {
      fs.unlinkSync(tombstone);
    } catch {
      // The rename succeeded, so the manifest IS gone from the
      // original path. A failed tombstone unlink leaks a file but
      // doesn't break the wipe intent.
    }
    return { committed: true };
  }

  // Mismatch — we tombstoned a different daemon's manifest. Try to
  // restore it via link (atomic-or-fail: only succeeds if the
  // original path is currently empty).
  try {
    fs.linkSync(tombstone, file);
    fs.unlinkSync(tombstone);
    return { committed: false, reason: "different_manifest_restored" };
  } catch (linkErr) {
    const linkCode = /** @type {NodeJS.ErrnoException} */ (linkErr).code;
    // Best-effort cleanup of the tombstone.
    try {
      fs.unlinkSync(tombstone);
    } catch {
      /* best-effort */
    }
    if (linkCode === "EEXIST") {
      // Yet-another-fresher manifest is at the path. Operator has
      // the newest one; the daemon we tombstoned just loses its
      // discovery file. Bounded loss.
      return { committed: false, reason: "newer_manifest_present" };
    }
    return {
      committed: false,
      reason: `restore_failed:${linkErr instanceof Error ? linkErr.message : String(linkErr)}`
    };
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
