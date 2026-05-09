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

import { execFileSync } from "node:child_process";
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
 *   startedAt: string,
 *   childStartedAtOs?: string | null
 * }} PidFileBody
 *
 * @typedef {PidFileBody & { path: string }} RegistryEntry
 *
 * @typedef {RegistryEntry & { reason: "parent-dead" | "stale" }} OrphanEntry
 *
 * @typedef {(pid: number) => string | null} ReadProcStartTime
 */

/**
 * Read the OS-reported start time of a PID. Returns a platform-specific
 * opaque string that's stable per process — we compare it byte-for-byte
 * to detect PID reuse, so the format only needs to be self-consistent.
 *
 * Why: PIDs are reused. After a child dies and the OS recycles its PID
 * to an unrelated process, a naive orphan-reaper would SIGKILL that
 * unrelated process. Capturing the start time at register and verifying
 * it before signaling closes that hole — the same PID with a different
 * start time is definitively not the runner we tracked.
 *
 * Platform impl:
 *   - POSIX (linux / darwin / freebsd / etc.): `ps -o lstart= -p <pid>`
 *     returns a fixed-width local-time stamp like
 *     `Mon May  8 10:23:45 2026`. The trailing `=` suppresses the
 *     header. Available on every UNIX with a `ps` in PATH.
 *   - Windows (win32): PowerShell's `Get-CimInstance Win32_Process`
 *     filters by `ProcessId` and returns the `CreationDate` field. We
 *     prefer `pwsh` (PowerShell 7+, cross-platform) when available and
 *     fall back to `powershell.exe` (Windows-PowerShell 5, ships with
 *     Windows 10+). Avoids the deprecated `wmic` which is being
 *     removed in modern Windows builds. The CreationDate is returned
 *     as a CIM datetime like `20260508103045.123456+000` — opaque to
 *     us, but stable per-process.
 *
 * Returns null on any error (binary missing, process gone, permission
 * denied, etc.). That's a degraded mode (no start-time guard) but never
 * results in a wrong-kill — the reaper falls back to PID-only checks
 * which can mis-target on platforms without a working start-time probe.
 *
 * @type {ReadProcStartTime}
 */
export function readProcStartTime(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      // Argument is shell-safe: we pass via execFileSync's argv (no
      // shell), and the only interpolation is `${pid}` which is
      // already validated as a finite positive number above.
      const script = `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop | Select-Object -ExpandProperty CreationDate).ToString()`;
      const candidates = ["pwsh", "powershell.exe"];
      for (const exe of candidates) {
        try {
          const out = execFileSync(exe, ["-NoProfile", "-Command", script], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2000
          });
          const trimmed = out.trim();
          if (trimmed) return trimmed;
        } catch {
          // try next candidate
        }
      }
      return null;
    }
    // POSIX
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

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
 * @param {Omit<PidFileBody, "startedAt" | "childStartedAtOs">} body
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => Date,
 *   randomBytes?: () => string,
 *   readProcStartTime?: ReadProcStartTime
 * }} [options]
 * @returns {string | null}
 */
export function registerRunner(body, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const readStart = options.readProcStartTime ?? readProcStartTime;
  const pidPath = buildPidFilePath(body.runner, {
    env,
    randomBytes: options.randomBytes
  });
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    // Capture the OS-reported start time of the child immediately after
    // spawn so the orphan-reaper can verify identity before signaling.
    // Null is acceptable (degraded mode — falls back to PID-only checks
    // which can mis-target a recycled PID, but only when ps is missing).
    const childStartedAtOs = readStart(body.childPid);
    /** @type {PidFileBody} */
    const record = {
      ...body,
      startedAt: now().toISOString(),
      childStartedAtOs
    };
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
 * PID-reuse safety:
 *   When the child PID has exited and the OS recycles it to a new
 *   process, a naive "is the child alive?" check returns true and the
 *   reaper would SIGKILL the wrong process. Each pid file stores the
 *   OS-reported start time of the child captured at register; before
 *   classifying as orphan we re-read the start time and require it to
 *   match. A mismatch means the PID belongs to someone else now —
 *   classify as `stale` (just unlink the metadata file) rather than
 *   orphan. If the start time wasn't captured (degraded mode where
 *   `ps` is missing), we skip the verification and behave as before.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => Date,
 *   maxAgeMs?: number,
 *   reap?: boolean,
 *   readProcStartTime?: ReadProcStartTime
 * }} [options]
 * @returns {{ orphaned: OrphanEntry[], stale: RegistryEntry[] }}
 */
export function checkOrphanedRunners(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000; // 1h default
  const reap = options.reap ?? false;
  const readStart = options.readProcStartTime ?? readProcStartTime;

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
    // PID is alive — but is it still OUR child, or has the OS recycled
    // the PID? If we have a captured start time, verify it matches.
    if (entry.childStartedAtOs) {
      const live = readStart(entry.childPid);
      if (live && live !== entry.childStartedAtOs) {
        // Different process now occupies that PID. The runner's child
        // is gone; treat the file as stale leaked metadata. DO NOT
        // signal — we'd kill an unrelated process.
        stale.push(entry);
        continue;
      }
      // live === null is treated as "can't verify"; fall through and
      // proceed with the parent-dead / age check. This preserves
      // previous behavior on systems without `ps`.
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
      // Re-verify identity at the moment of signaling. The classify
      // pass above did its own verification, but a process can exit
      // between classification and signaling; re-checking here closes
      // the race window where the PID was recycled in the interim.
      // If verification fails, just unlink the file — never signal.
      let safeToSignal = true;
      if (o.childStartedAtOs) {
        const live = readStart(o.childPid);
        if (live && live !== o.childStartedAtOs) safeToSignal = false;
      }
      if (safeToSignal) {
        try {
          process.kill(o.childPid, "SIGKILL");
        } catch {
          // already gone, no permission, etc.
        }
      }
      deregisterRunner(o.path);
    }
    for (const s of stale) {
      deregisterRunner(s.path);
    }
  }

  return { orphaned, stale };
}
