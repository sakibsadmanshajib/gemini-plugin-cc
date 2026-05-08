/**
 * Unit tests for `lib/runners/orphan-check.mjs`.
 *
 * Coverage:
 *   - getRunnerPidDir env override
 *   - buildPidFilePath filename format + random suffix uniqueness
 *   - registerRunner writes a valid JSON pid file with mode 0o600
 *   - deregisterRunner removes the file; ENOENT silently ignored
 *   - readRegistry parses well-formed entries, skips malformed,
 *     ignores files that don't match the canonical name pattern
 *   - isPidAlive: current process alive; known-dead PID dead; bogus PIDs dead
 *   - checkOrphanedRunners classifications:
 *       * stale (child PID gone)
 *       * orphaned (alive child, parent dead)
 *       * orphaned (alive child, alive parent, but too old)
 *       * clean (alive child, alive parent, fresh) — not flagged
 *   - reap: true SIGKILLs orphans + removes pid files
 *
 * Each test creates a unique temp dir so concurrent test runs don't
 * race on the registry directory.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  buildPidFilePath,
  checkOrphanedRunners,
  deregisterRunner,
  getRunnerPidDir,
  isPidAlive,
  readRegistry,
  registerRunner
} from "#lib/runners/orphan-check.mjs";

/** @type {string} */
let tmpDir;
/** @type {NodeJS.ProcessEnv} */
let env;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `orphan-check-${crypto.randomBytes(4).toString("hex")}-`)
  );
  env = { ...process.env, ACP_RUNNER_PID_DIR: tmpDir };
});

afterEach(() => {
  // Best-effort cleanup; tmp dir survival is OK in CI but locally we'd
  // accumulate orphan-check-* dirs without this.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore — sandboxed runners may have file-permission quirks.
  }
});

describe("getRunnerPidDir", () => {
  test("honors ACP_RUNNER_PID_DIR override", () => {
    expect(getRunnerPidDir({ ACP_RUNNER_PID_DIR: "/custom/path" })).toBe("/custom/path");
  });

  test("falls back to os.tmpdir() when env unset", () => {
    expect(getRunnerPidDir({})).toBe(os.tmpdir());
  });
});

describe("buildPidFilePath", () => {
  test("filename matches <runner>-agent-<8hex>.pid", () => {
    const p = buildPidFilePath(BACKEND_NAMES.CLAUDE, { env });
    expect(path.dirname(p)).toBe(tmpDir);
    expect(/^claude-agent-[0-9a-f]+\.pid$/.test(path.basename(p))).toBe(true);
  });

  test("random suffix differs across calls (collisions vanishingly rare)", () => {
    const a = buildPidFilePath(BACKEND_NAMES.CLAUDE, { env });
    const b = buildPidFilePath(BACKEND_NAMES.CLAUDE, { env });
    expect(a).not.toBe(b);
  });

  test("random fn override is honored", () => {
    const p = buildPidFilePath(BACKEND_NAMES.CODEX, {
      env,
      randomBytes: () => "deadbeef"
    });
    expect(path.basename(p)).toBe("codex-agent-deadbeef.pid");
  });
});

describe("registerRunner / deregisterRunner", () => {
  test("registerRunner writes a valid JSON pid file", () => {
    const pidPath = registerRunner(
      {
        childPid: 12345,
        parentPid: process.pid,
        runner: BACKEND_NAMES.GEMINI,
        command: "gemini",
        args: ["-p", "hello"]
      },
      { env }
    );
    expect(pidPath).toBeTruthy();
    const body = JSON.parse(fs.readFileSync(/** @type {string} */ (pidPath), "utf8"));
    expect(body.childPid).toBe(12345);
    expect(body.parentPid).toBe(process.pid);
    expect(body.runner).toBe(BACKEND_NAMES.GEMINI);
    expect(body.command).toBe("gemini");
    expect(body.args).toEqual(["-p", "hello"]);
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt).getTime()).toBeGreaterThan(0);
  });

  test("registerRunner returns null if directory unwritable", () => {
    const badEnv = { ACP_RUNNER_PID_DIR: "/dev/null/cannot-create-here" };
    const pidPath = registerRunner(
      {
        childPid: 1,
        parentPid: 1,
        runner: BACKEND_NAMES.CLAUDE,
        command: "claude",
        args: []
      },
      { env: badEnv }
    );
    expect(pidPath).toBeNull();
  });

  test("deregisterRunner removes the file", () => {
    const pidPath = /** @type {string} */ (
      registerRunner(
        {
          childPid: 1,
          parentPid: 1,
          runner: BACKEND_NAMES.CLAUDE,
          command: "claude",
          args: []
        },
        { env }
      )
    );
    expect(fs.existsSync(pidPath)).toBe(true);
    deregisterRunner(pidPath);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  test("deregisterRunner is silent on ENOENT (already gone)", () => {
    expect(() => deregisterRunner(path.join(tmpDir, "claude-agent-nonexistent.pid"))).not.toThrow();
  });

  test("deregisterRunner is silent on null/undefined input", () => {
    expect(() => deregisterRunner(null)).not.toThrow();
    expect(() => deregisterRunner(undefined)).not.toThrow();
  });
});

describe("readRegistry", () => {
  test("returns empty array when directory doesn't exist", () => {
    expect(readRegistry({ env: { ACP_RUNNER_PID_DIR: "/no/such/path" } })).toEqual([]);
  });

  test("returns empty array when directory exists but has no pid files", () => {
    expect(readRegistry({ env })).toEqual([]);
  });

  test("parses well-formed pid files", () => {
    registerRunner(
      {
        childPid: 100,
        parentPid: 200,
        runner: BACKEND_NAMES.CODEX,
        command: "codex",
        args: ["exec"]
      },
      { env }
    );
    const entries = readRegistry({ env });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      childPid: 100,
      parentPid: 200,
      runner: BACKEND_NAMES.CODEX,
      command: "codex"
    });
    expect(entries[0].path).toBeTruthy();
  });

  test("skips files that don't match the canonical name pattern", () => {
    fs.writeFileSync(path.join(tmpDir, "random.txt"), "not a pid file");
    fs.writeFileSync(path.join(tmpDir, "claude.pid"), '{"childPid": 1}'); // missing -agent-
    fs.writeFileSync(path.join(tmpDir, "claude-agent-NOTHEX.pid"), "{}"); // bad suffix
    registerRunner(
      {
        childPid: 1,
        parentPid: 2,
        runner: BACKEND_NAMES.CLAUDE,
        command: "claude",
        args: []
      },
      { env }
    );
    const entries = readRegistry({ env });
    expect(entries).toHaveLength(1);
  });

  test("skips malformed pid files (bad JSON, missing fields)", () => {
    fs.writeFileSync(path.join(tmpDir, "claude-agent-aaaaaaaa.pid"), "not json");
    fs.writeFileSync(path.join(tmpDir, "codex-agent-bbbbbbbb.pid"), '{"missing": "fields"}');
    expect(readRegistry({ env })).toHaveLength(0);
  });
});

describe("isPidAlive", () => {
  test("current process PID is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("PID 1 is treated as alive (init/launchd; EPERM on signal-0)", () => {
    // Caveat: in some sandboxed environments PID 1 may not be reachable.
    // The function returns true on EPERM (alive but unsignalable), which
    // is the right default for orphan-check (don't reap what you can't own).
    // We accept either true (EPERM path) or true (signal succeeded).
    expect(isPidAlive(1)).toBe(true);
  });

  test("non-positive PIDs are dead", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });

  test("recently-exited PID is dead", async () => {
    // Spawn a child that exits immediately, capture its PID, wait for
    // exit, then check.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = /** @type {number} */ (child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    // On macOS/Linux, the kernel may keep the PID slot reserved briefly
    // even after the process is reaped. Give it a tick before checking.
    await new Promise((r) => setTimeout(r, 50));
    expect(isPidAlive(pid)).toBe(false);
  });
});

describe("checkOrphanedRunners — classification", () => {
  test("clean entry (alive child, alive parent, fresh): not flagged", () => {
    registerRunner(
      {
        childPid: process.pid, // self → alive
        parentPid: process.pid, // self → alive
        runner: BACKEND_NAMES.CLAUDE,
        command: "claude",
        args: []
      },
      { env }
    );
    const result = checkOrphanedRunners({ env });
    expect(result.orphaned).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  test("stale entry (child PID gone): flagged as stale, not orphaned", async () => {
    // Use a child that exits, then register its dead PID.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = /** @type {number} */ (child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((r) => setTimeout(r, 50));

    registerRunner(
      {
        childPid: deadPid,
        parentPid: process.pid,
        runner: BACKEND_NAMES.CODEX,
        command: "codex",
        args: []
      },
      { env }
    );
    const result = checkOrphanedRunners({ env });
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].childPid).toBe(deadPid);
    expect(result.orphaned).toEqual([]);
  });

  test("orphan: alive child + dead parent → flagged with reason 'parent-dead'", async () => {
    // Spawn a long-running child as the "live" target.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const liveChildPid = /** @type {number} */ (child.pid);

    // Use a known-dead PID for the parent. Spawn-and-exit pattern.
    const deadParent = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadParentPid = /** @type {number} */ (deadParent.pid);
    await new Promise((resolve) => deadParent.on("exit", resolve));
    await new Promise((r) => setTimeout(r, 50));

    try {
      registerRunner(
        {
          childPid: liveChildPid,
          parentPid: deadParentPid,
          runner: BACKEND_NAMES.GEMINI,
          command: "gemini",
          args: []
        },
        { env }
      );
      const result = checkOrphanedRunners({ env });
      expect(result.orphaned).toHaveLength(1);
      expect(result.orphaned[0].reason).toBe("parent-dead");
      expect(result.orphaned[0].childPid).toBe(liveChildPid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("orphan: too-old entry → flagged with reason 'stale'", () => {
    // Register with a manually-controlled `now` that pretends time has
    // passed since startedAt.
    const startTime = new Date("2025-01-01T00:00:00Z");
    registerRunner(
      {
        childPid: process.pid,
        parentPid: process.pid,
        runner: BACKEND_NAMES.CLAUDE,
        command: "claude",
        args: []
      },
      { env, now: () => startTime }
    );

    const lookTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // +2h
    const result = checkOrphanedRunners({
      env,
      now: () => lookTime,
      maxAgeMs: 60 * 60 * 1000
    });
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0].reason).toBe("stale");
  });
});

describe("checkOrphanedRunners — reap", () => {
  test("reap: true removes stale entries' pid files", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = /** @type {number} */ (child.pid);
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((r) => setTimeout(r, 50));

    registerRunner(
      {
        childPid: deadPid,
        parentPid: process.pid,
        runner: BACKEND_NAMES.CODEX,
        command: "codex",
        args: []
      },
      { env }
    );
    expect(readRegistry({ env })).toHaveLength(1);

    const result = checkOrphanedRunners({ env, reap: true });
    expect(result.stale).toHaveLength(1);
    expect(readRegistry({ env })).toHaveLength(0);
  });

  test("reap: true with no orphans/stale: pid files survive", () => {
    registerRunner(
      {
        childPid: process.pid,
        parentPid: process.pid,
        runner: BACKEND_NAMES.CLAUDE,
        command: "claude",
        args: []
      },
      { env }
    );
    checkOrphanedRunners({ env, reap: true });
    expect(readRegistry({ env })).toHaveLength(1);
  });
});
