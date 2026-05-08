/**
 * Orphan-runner detection and reaping via per-process PID files.
 *
 * On spawn, each runner writes one PID file at:
 *
 *   <dir>/<runner>-agent-<random>.pid
 *
 * where `<dir>` is `$ACP_RUNNER_PID_DIR` (override) or `os.tmpdir()`,
 * `<runner>` is `claude` / `codex` / `gemini`, and `<random>` is an
 * 8-hex-char random suffix that makes the filename unique without
 * coordination across concurrent runners.
 *
 * The PID file is JSON containing:
 *   { childPid, parentPid, runner, command, args, startedAt }
 *
 * On clean exit the runner unlinks its file. If the parent crashes
 * mid-flight, the file persists and the orphaned child may continue
 * running. `checkOrphanedRunners()` walks the directory, classifies
 * each entry, and optionally SIGKILLs orphaned children.
 *
 * Why per-process files (not a shared registry):
 *   - No write contention; concurrent spawns don't race on a single
 *     append-and-rewrite registry file.
 *   - Cleanup is one `unlink()`; no read-filter-rewrite cycle.
 *   - The directory listing is the authoritative live set; no need to
 *     read-and-prune metadata to figure out who's alive.
 *
 * Why `os.tmpdir()`: matches the project's `Host detection` contract
 * (Codex hosts use `$TMPDIR/gemini-companion/...`); `tmp` is the
 * appropriate place for ephemeral runtime state. Override via
 * `ACP_RUNNER_PID_DIR` for tests or non-default placement.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {import("#lib/backends/names.mjs").BackendName} RunnerName
 *
 * @typedef {{
 *   childPid: number,
 *   parentPid: number,
 *   runner: RunnerName,
 *   command: string,
 *   args: string[],
 *   startedAt: string
 * }} PidFileBody
 *
 * @typedef {PidFileBody & { path: string }} RegistryEntry
 *
 * @typedef {RegistryEntry & { reason: "parent-dead" | "stale" }} OrphanEntry
 */

/**
 * Resolve the directory where pid files live. `$ACP_RUNNER_PID_DIR`
 * wins; otherwise `os.tmpdir()`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getRunnerPidDir(env = process.env) {
  return env.ACP_RUNNER_PID_DIR || os.tmpdir();
}

/**
 * Build the canonical pid-file path for a runner. The random suffix is
 * 8 hex chars from `crypto.randomBytes(4)` — collision probability is
 * negligible for the population sizes a single host runs.
 *
 * @param {RunnerName} runner
 * @param {{ env?: NodeJS.ProcessEnv, randomBytes?: () => string }} [options]
 * @returns {string}
 */
export function buildPidFilePath(runner, options = {}) {
  const env = options.env ?? process.env;
  const randomBytes = options.randomBytes ?? (() => crypto.randomBytes(4).toString("hex"));
  return path.join(getRunnerPidDir(env), `${runner}-agent-${randomBytes()}.pid`);
}

/**
 * Write a pid file for a freshly-spawned runner. Best-effort — failures
 * (unwritable directory, permission denied) silently proceed; orphan
 * tracking is observability, not load-bearing.
 *
 * Returns the pid-file path so the caller can pass it to
 * `deregisterRunner` on clean exit. Returns null on failure (the
 * runner still works, just isn't tracked).
 *
 * @param {Omit<PidFileBody, "startedAt">} body
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date, randomBytes?: () => string }} [options]
 * @returns {string | null}
 */
export function registerRunner(body, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const pidPath = buildPidFilePath(body.runner, {
    env,
    randomBytes: options.randomBytes
  });
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    /** @type {PidFileBody} */
    const record = { ...body, startedAt: now().toISOString() };
    fs.writeFileSync(pidPath, JSON.stringify(record), { mode: 0o600 });
    return pidPath;
  } catch {
    return null;
  }
}

/**
 * Remove a pid file. Best-effort; ENOENT is ignored.
 *
 * @param {string | null | undefined} pidPath
 */
export function deregisterRunner(pidPath) {
  if (!pidPath) return;
  try {
    fs.unlinkSync(pidPath);
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code !== "ENOENT") {
      // Other errors swallowed — we're best-effort here.
    }
  }
}

/**
 * List all current pid files in the runner directory (any backend).
 * Returns parsed entries; malformed files are silently skipped (the
 * orphan-check is observability, not validation).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {RegistryEntry[]}
 */
export function readRegistry(options = {}) {
  const env = options.env ?? process.env;
  const dir = getRunnerPidDir(env);
  if (!fs.existsSync(dir)) return [];

  /** @type {RegistryEntry[]} */
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^(claude|codex|gemini)-agent-[0-9a-f]+\.pid$/.test(name)) continue;
    const pidPath = path.join(dir, name);
    try {
      const text = fs.readFileSync(pidPath, "utf8");
      const body = /** @type {PidFileBody} */ (JSON.parse(text));
      if (typeof body.childPid !== "number" || typeof body.parentPid !== "number") continue;
      out.push({ ...body, path: pidPath });
    } catch {
      // Malformed or transiently disappearing file; skip.
    }
  }
  return out;
}

/**
 * Check whether a PID is currently alive. Uses `process.kill(pid, 0)`
 * — signal 0 only checks permission/existence. Returns false on ESRCH,
 * true on EPERM (the process exists; we just can't signal it — counts
 * as alive for orphan-check purposes since we shouldn't reap what we
 * don't own).
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Walk the pid-file directory and classify each entry.
 *
 *   - `stale` — the child PID has exited; the pid file is leaked
 *     metadata. Always cleaned up when `reap: true`.
 *   - `orphaned` — the child is still alive but either (a) the parent
 *     PID is gone, or (b) the entry is older than `maxAgeMs`. SIGKILLed
 *     when `reap: true`.
 *
 * `reap: false` (default) is observation-only: callers get the lists
 * back and decide what to do.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => Date,
 *   maxAgeMs?: number,
 *   reap?: boolean
 * }} [options]
 * @returns {{ orphaned: OrphanEntry[], stale: RegistryEntry[] }}
 */
export function checkOrphanedRunners(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000; // 1h default
  const reap = options.reap ?? false;

  const entries = readRegistry({ env });
  /** @type {OrphanEntry[]} */
  const orphaned = [];
  /** @type {RegistryEntry[]} */
  const stale = [];

  for (const entry of entries) {
    if (!isPidAlive(entry.childPid)) {
      stale.push(entry);
      continue;
    }
    const age = now().getTime() - new Date(entry.startedAt).getTime();
    /** @type {"parent-dead" | "stale" | null} */
    let reason = null;
    if (!isPidAlive(entry.parentPid)) reason = "parent-dead";
    else if (age > maxAgeMs) reason = "stale";

    if (reason) orphaned.push({ ...entry, reason });
  }

  if (reap) {
    for (const o of orphaned) {
      try {
        process.kill(o.childPid, "SIGKILL");
      } catch {
        // already gone, no permission, etc.
      }
      deregisterRunner(o.path);
    }
    for (const s of stale) {
      deregisterRunner(s.path);
    }
  }

  return { orphaned, stale };
}
