/**
 * Auto-start the `artagon-openai-server` daemon when a slash-command
 * finds no live manifest (Step 4a of the unified-facade plan).
 *
 * Flow:
 *   1. Acquire an exclusive lock on $XDG_STATE_HOME/artagon-agent-cli-
 *      plugin/auto-start.lock so two concurrent slash-commands don't
 *      both spawn the daemon.
 *   2. Re-check the manifest under the lock. If another process won
 *      the race and a daemon is up, return — we don't spawn a second.
 *   3. Spawn `artagon-openai-server` detached + unref so the daemon
 *      outlives the slash-command. stdio is "ignore" (the daemon
 *      writes its own log; we don't want to inherit pipes that the
 *      slash-command will close on exit).
 *   4. Poll the manifest until it appears (or timeout). The daemon
 *      writes the manifest after binding its listening socket; once
 *      we see it, we can fetch().
 *   5. Release the lock.
 *
 * Failure modes (loud, not silent):
 *   - Lock acquire times out → throw with the lock path so the operator
 *     can `rm` a stale lock manually.
 *   - Spawn fails (ENOENT, EPERM) → throw with the cause.
 *   - Manifest never appears within `MANIFEST_POLL_TIMEOUT_MS` → throw
 *     with the path the daemon was supposed to write.
 *
 * Why proper-lockfile (mature, ~3KB) instead of inline:
 *   - Stale-lock detection via lock-file mtime + pid liveness, which we
 *     don't want to reimplement.
 *   - Cross-platform (Windows + POSIX) semantics that match the
 *     install-paths story.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @ts-ignore — proper-lockfile ships no .d.ts. Treated as any.
import lockfile from "proper-lockfile";

import { manifestPaths, readManifest } from "./facade-endpoint.mjs";

const LOCK_FILENAME = "auto-start.lock";
const MANIFEST_POLL_INTERVAL_MS = 100;
const MANIFEST_POLL_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/**
 * Resolve the absolute path to the `artagon-openai-server` bin.
 *
 * Used when the slash-command needs to spawn the daemon and we can't
 * rely on it being on PATH. The bin lives in `bin/` of the plugin
 * install tree, two `..` hops from this module.
 *
 * @returns {string}
 */
function defaultDaemonBin() {
  const here = fileURLToPath(import.meta.url);
  // lib/server/auto-start.mjs → ../../bin/artagon-openai-server.mjs
  return path.resolve(here, "..", "..", "..", "bin", "artagon-openai-server.mjs");
}

/**
 * Sleep helper.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-start the facade daemon if no manifest is present (or the
 * manifest is stale). Returns the manifest once the daemon is reachable.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   daemonBin?: string,
 *   args?: string[],
 *   pollIntervalMs?: number,
 *   pollTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<import("./facade-endpoint.mjs").FacadeManifest>}
 */
export async function autoStartFacade(options = {}) {
  const env = options.env ?? process.env;
  const daemonBin = options.daemonBin ?? defaultDaemonBin();
  const args = options.args ?? [];
  const pollInterval = options.pollIntervalMs ?? MANIFEST_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? MANIFEST_POLL_TIMEOUT_MS;

  // Already running? Cheap pre-check before lock acquisition.
  const existing = readManifest(env);
  if (existing) return existing;

  const { dir } = manifestPaths(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, LOCK_FILENAME);

  // Lockfile target must exist before proper-lockfile can lock it.
  try {
    fs.writeFileSync(lockPath, "", { flag: "a", mode: 0o600 });
  } catch (err) {
    throw new Error(
      `auto-start: cannot create lock target ${lockPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  /** @type {() => Promise<void>} */
  let releaseLock;
  try {
    releaseLock = await lockfile.lock(lockPath, {
      stale: LOCK_STALE_MS,
      retries: { retries: 50, minTimeout: 50, maxTimeout: 100 }
    });
  } catch (err) {
    throw new Error(
      `auto-start: failed to acquire lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        "If a previous daemon crashed, rm the lock and retry."
    );
  }

  try {
    // Recheck under the lock — someone may have just started a daemon.
    const afterLock = readManifest(env);
    if (afterLock) return afterLock;

    // Spawn the daemon detached so it outlives this slash-command.
    // stdio "ignore" detaches from the parent's pipes; the daemon
    // writes its own log via stderr (no log file today; that's a
    // follow-up).
    const child = spawn(process.execPath, [daemonBin, ...args], {
      detached: true,
      stdio: "ignore",
      env
    });
    if (typeof child.unref === "function") child.unref();

    // Poll for the manifest. The daemon writes it after binding the
    // listening socket; once we see it we know the HTTP endpoint is
    // accepting connections.
    const start = Date.now();
    while (Date.now() - start < pollTimeout) {
      await sleep(pollInterval);
      const manifest = readManifest(env);
      if (manifest) return manifest;
    }
    throw new Error(
      `auto-start: daemon manifest never appeared at ${manifestPaths(env).file} ` +
        `within ${pollTimeout}ms. Check daemon logs.`
    );
  } finally {
    try {
      await releaseLock();
    } catch {
      // best-effort; proper-lockfile auto-releases on process exit
    }
  }
}
