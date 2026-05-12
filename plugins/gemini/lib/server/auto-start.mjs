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

// Q4 (round-11): disk-backed circuit breaker for sustained-crash
// daemons. Each slash-command invocation is a fresh process, so an
// in-memory counter can't track operator-driven retry loops. We
// persist the timestamps of the last N failed auto-starts to JSON
// and refuse a new spawn when there are too many recent failures.
// The operator is told to look at the boot log instead of getting
// "retry the command" advice that will fail the same way again.
const FAILURE_LOG_FILENAME = "auto-start-failures.json";
const FAILURE_WINDOW_MS = 5 * 60_000; // 5 minutes
const FAILURE_THRESHOLD = 3; // 3 failures in window → tripped

/**
 * Resolve the absolute path to the `artagon-openai-server` bin.
 *
 * J1: this module is vendored into `plugins/<host>/lib/server/`. The
 * canonical bin lives in `bin/` at the repo root, but plugin trees
 * don't have one. We try a couple of likely locations and fall back
 * to PATH ("artagon-openai-server" — npm publishes it as a bin).
 *
 * @returns {{ command: string, useNode: boolean }}
 *   `useNode`: spawn via `process.execPath <command>` (true when
 *   command is a .mjs path) vs spawn the bin directly (false when
 *   it's a PATH name with shebang).
 */
function defaultDaemonBin() {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    // canonical repo install: lib/server/auto-start.mjs → ../../bin/
    path.resolve(here, "..", "..", "..", "bin", "artagon-openai-server.mjs"),
    // plugin install one level deeper: plugins/host/lib/server/ → ../../../bin/
    path.resolve(here, "..", "..", "..", "..", "bin", "artagon-openai-server.mjs")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, useNode: true };
    }
  }
  // PATH fallback. npm publishes artagon-openai-server as a bin entry
  // (package.json#bin) so a marketplace install will have it on PATH.
  return { command: "artagon-openai-server", useNode: false };
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
 * Q4 circuit breaker — read the recent-failure log and return the
 * count of failures inside the rolling window. Stale entries outside
 * the window are pruned (returned as the new on-disk shape) so the
 * file doesn't grow unboundedly across operator sessions.
 *
 * @param {string} failureLogPath
 * @param {number} nowMs
 * @returns {{ recentFailures: number[], prunedAny: boolean }}
 */
function readFailureLog(failureLogPath, nowMs) {
  /** @type {number[]} */
  let timestamps = [];
  try {
    const text = fs.readFileSync(failureLogPath, "utf8");
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      timestamps = parsed.filter((t) => typeof t === "number" && Number.isFinite(t));
    }
  } catch {
    // Missing or malformed file → start fresh. No need to surface
    // this to the operator; circuit-breaker history is best-effort.
  }
  // R2 (round-12): bound the window on BOTH sides. Future-dated
  // timestamps from a backwards NTP step or a hand-edited log would
  // otherwise survive every prune and keep the breaker tripped
  // forever. Treat t > nowMs as invalid and drop it.
  const cutoff = nowMs - FAILURE_WINDOW_MS;
  const recentFailures = timestamps.filter((t) => t >= cutoff && t <= nowMs);
  return {
    recentFailures,
    prunedAny: recentFailures.length !== timestamps.length
  };
}

/**
 * Append a fresh failure timestamp to the rolling log. Writes the
 * pruned + appended list back atomically (temp + rename) so a
 * crash mid-write can't corrupt the JSON.
 *
 * @param {string} failureLogPath
 * @param {number[]} priorRecent
 * @param {number} nowMs
 */
function appendFailure(failureLogPath, priorRecent, nowMs) {
  const next = [...priorRecent, nowMs];
  const tmp = `${failureLogPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, failureLogPath);
  } catch (err) {
    // Best-effort: a failed write doesn't break the slash-command,
    // but the next operator retry won't see this failure in the log.
    // Surface to stderr so a tight crash loop produces SOME signal.
    process.stderr.write(
      `[auto-start] failed to record failure timestamp: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/**
 * Reset the circuit breaker on successful auto-start. Without this a
 * historical bad run would stay in the log and block a subsequent
 * fix the operator made — even though the daemon is now healthy.
 *
 * @param {string} failureLogPath
 */
function clearFailureLog(failureLogPath) {
  try {
    fs.unlinkSync(failureLogPath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
      // Same best-effort posture as appendFailure.
      process.stderr.write(
        `[auto-start] failed to clear failure log: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
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
  /** @type {{ command: string, useNode: boolean }} */
  const daemonBin =
    typeof options.daemonBin === "string"
      ? {
          command: options.daemonBin,
          useNode: options.daemonBin.endsWith(".mjs")
        }
      : defaultDaemonBin();
  const args = options.args ?? [];
  const pollInterval = options.pollIntervalMs ?? MANIFEST_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? MANIFEST_POLL_TIMEOUT_MS;
  // J3: capture daemon stderr to a log file so a failed boot is
  // diagnosable. stdio: "ignore" would silently drop the daemon's
  // own listen-fail / auth-fail / port-in-use messages.
  const { dir: logDir } = manifestPaths(env);
  const logPath = path.join(logDir, "auto-start.log");

  // Already running? Cheap pre-check before lock acquisition.
  const existing = readManifest(env);
  if (existing) return existing;

  const { dir } = manifestPaths(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, LOCK_FILENAME);
  const failureLogPath = path.join(dir, FAILURE_LOG_FILENAME);

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

  // R1 (round-12): the Q4 breaker check + appendFailure now run INSIDE
  // the lock. Two concurrent slash-commands previously both passed a
  // lock-free pre-check at 2 failures, both serialized through the
  // lock, both spawned + failed, and because each append re-read the
  // log fresh, last-writer-wins on the rename meant only ONE of the
  // two failures got recorded — defeating the breaker in exactly the
  // scenario it exists to catch. Inside the lock, reads + writes
  // serialize naturally; cost is zero because the spawn window
  // already holds the lock.
  /** @type {number[]} */
  let recentFailures;

  try {
    // Recheck under the lock — someone may have just started a daemon.
    const afterLock = readManifest(env);
    if (afterLock) return afterLock;

    // R1: re-read the failure log under the lock so a concurrent
    // append from another slash-command (now blocked on this lock) is
    // visible to us. Then check the breaker BEFORE spawning.
    const nowMs = Date.now();
    const fresh = readFailureLog(failureLogPath, nowMs);
    recentFailures = fresh.recentFailures;
    if (recentFailures.length >= FAILURE_THRESHOLD) {
      const windowMin = Math.round(FAILURE_WINDOW_MS / 60_000);
      throw new Error(
        `auto-start: circuit breaker tripped — daemon failed ${recentFailures.length} times ` +
          `in the last ${windowMin} minute(s). Fix the underlying issue (check ${logPath}) ` +
          `and either wait for the breaker to expire or run \`rm ${failureLogPath}\` to reset.`
      );
    }

    // Spawn the daemon detached so it outlives this slash-command.
    // J3: redirect daemon stdio to a log file under XDG state. The
    // daemon's listen-fail / auth-fail messages would otherwise be
    // unreachable to operators chasing "daemon never started".
    const logFd = fs.openSync(logPath, "a", 0o600);
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      if (daemonBin.useNode) {
        child = spawn(process.execPath, [daemonBin.command, ...args], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env
        });
      } else {
        // PATH fallback: spawn the bin directly (npm shebang handles node).
        child = spawn(daemonBin.command, args, {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env
        });
      }
    } finally {
      // Once spawn inherits the fd, our copy can be closed. The child
      // keeps its dup'd handle alive for its own lifetime.
      try {
        fs.closeSync(logFd);
      } catch {
        // best-effort
      }
    }
    // J2: surface spawn ENOENT/EACCES immediately. Without this listener,
    // the error fires asynchronously and is swallowed; the polling loop
    // hits its 5s timeout with no operator-visible diagnostic.
    /** @type {Error | null} */
    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        spawnError = new Error(
          `daemon exited with code ${code}${signal ? ` (signal ${signal})` : ""}`
        );
      }
    });
    if (typeof child.unref === "function") child.unref();

    // Poll for the manifest. The daemon writes it after binding the
    // listening socket; once we see it we know the HTTP endpoint is
    // accepting connections.
    const start = Date.now();
    while (Date.now() - start < pollTimeout) {
      await sleep(pollInterval);
      const manifest = readManifest(env);
      if (manifest) {
        // O1 (round-10): the daemon may have written the manifest and
        // THEN crashed during boot (port-bind succeeded, first-request
        // handler threw). The exit handler captures that into
        // spawnError, but if we return as soon as we see the manifest,
        // we never read it. Surface the crash as an auto-start failure
        // with the actual cause instead of letting the caller hit a
        // confusing ECONNREFUSED on the next request.
        //
        // The check is intentionally synchronous: if the exit event
        // hasn't fired yet (microseconds between manifest-write and
        // exit), we'll catch it on the NEXT request's K2 wipe path
        // (M2 race-safe deletion). No silent failure either way.
        if (spawnError) {
          /** @type {Error} */
          const err = spawnError;
          appendFailure(failureLogPath, recentFailures, Date.now());
          throw new Error(
            `auto-start: daemon wrote manifest then crashed (${err.message}). ` +
              `Check ${logPath} for details.`
          );
        }
        // Q4: successful spawn resets the breaker — operator fixed
        // whatever was wrong with the previous attempts.
        clearFailureLog(failureLogPath);
        return manifest;
      }
      // J2: break early when spawn failed (ENOENT/EACCES/non-zero exit).
      // No point in polling further when the child already gave up.
      if (spawnError) {
        appendFailure(failureLogPath, recentFailures, Date.now());
        throw new Error(
          `auto-start: daemon failed to start (${spawnError.message}). ` +
            `Check ${logPath} for details.`
        );
      }
    }
    appendFailure(failureLogPath, recentFailures, Date.now());
    throw new Error(
      `auto-start: daemon manifest never appeared at ${manifestPaths(env).file} ` +
        `within ${pollTimeout}ms. Check ${logPath} for daemon stderr.`
    );
  } finally {
    try {
      await releaseLock();
    } catch {
      // best-effort; proper-lockfile auto-releases on process exit
    }
  }
}
