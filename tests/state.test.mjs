import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  upsertJob
} from "../plugins/gemini/scripts/lib/state.mjs";
import { withWorkspaceMutex } from "../plugins/gemini/scripts/lib/atomic-state.mjs";
import { createTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";

test("resolveStateDir produces a deterministic per-workspace directory", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const stateDir = resolveStateDir(workspace);

  // Hash is 12 hex chars.
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{12}$/);
  // Calling again with the same workspace returns the same path.
  assert.equal(resolveStateDir(workspace), stateDir);
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when CLAUDE_ENV_FILE is also set (Claude Code host signal)", () => {
  // The runtime now requires BOTH CLAUDE_ENV_FILE (the actual Claude Code
  // session-hook signal) AND CLAUDE_PLUGIN_DATA. CLAUDE_PLUGIN_DATA alone is
  // not enough — a user who exports it in shell rc must not pull Codex into
  // Claude's state tree.
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousEnvFile = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  // Runtime stat()s CLAUDE_ENV_FILE before treating it as a Claude signal,
  // so we must actually create the file the var points at.
  const envFilePath = path.join(pluginDataDir, "session.env");
  fs.writeFileSync(envFilePath, "# Claude session env\n", "utf8");
  process.env.CLAUDE_ENV_FILE = envFilePath;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{12}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousEnvFile == null) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previousEnvFile;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const stateFile = resolveStateFile(workspace);
  const jobsDir = resolveJobsDir(workspace);
  fs.mkdirSync(jobsDir, { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("concurrent saveState writers do not unlink each other's job artifacts", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const jobA = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "a" });
  const jobB = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "b" });

  // Each writer has a stale snapshot that only knows about its own job.
  const stateA = loadState(workspace);
  const stateB = loadState(workspace);
  stateA.jobs = stateA.jobs.filter((j) => j.id === jobA.id);
  stateB.jobs = stateB.jobs.filter((j) => j.id === jobB.id);

  await Promise.all([
    Promise.resolve().then(() => saveState(workspace, stateA)),
    Promise.resolve().then(() => saveState(workspace, stateB))
  ]);

  const after = loadState(workspace);
  const ids = new Set(after.jobs.map((j) => j.id));
  assert.ok(ids.has(jobA.id), "jobA index entry must survive concurrent saveState");
  assert.ok(ids.has(jobB.id), "jobB index entry must survive concurrent saveState");

  const aFile = resolveJobFile(workspace, jobA.id);
  const bFile = resolveJobFile(workspace, jobB.id);
  const aLog = resolveJobLogFile(workspace, jobA.id);
  const bLog = resolveJobLogFile(workspace, jobB.id);
  // Both jobs' .json files must still exist — a stale snapshot must not
  // unlink another writer's in-flight artifacts.
  assert.equal(fs.existsSync(aFile), true, "jobA.json must not be unlinked");
  assert.equal(fs.existsSync(bFile), true, "jobB.json must not be unlinked");
  // Reconciled state must still reference each job's indexed logFile path,
  // regardless of whether the log file has been materialized yet.
  const afterById = new Map(after.jobs.map((j) => [j.id, j]));
  assert.equal(afterById.get(jobA.id)?.logFile, aLog);
  assert.equal(afterById.get(jobB.id)?.logFile, bLog);
});

test("setConfig reads state inside the workspace mutex", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "config race" });
  let pendingSetConfig;

  await withWorkspaceMutex(workspace, async () => {
    pendingSetConfig = setConfig(workspace, { stopReviewGate: true });
    const fresh = loadState(workspace);
    fresh.jobs = fresh.jobs.map((entry) =>
      entry.id === job.id
        ? { ...entry, pid: 123, healthStatus: "active", lastProgressAt: "2026-01-01T00:00:00.000Z" }
        : entry
    );
    fs.writeFileSync(resolveStateFile(workspace), `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
  });

  await pendingSetConfig;
  const [stored] = loadState(workspace).jobs;
  assert.equal(stored.pid, 123);
  assert.equal(stored.healthStatus, "active");
  assert.equal(stored.lastProgressAt, "2026-01-01T00:00:00.000Z");
});

test("upsertJob reads state inside the workspace mutex", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "upsert race" });
  let pendingUpsert;

  await withWorkspaceMutex(workspace, async () => {
    pendingUpsert = upsertJob(workspace, { id: job.id, title: "renamed" });
    const fresh = loadState(workspace);
    fresh.jobs = fresh.jobs.map((entry) =>
      entry.id === job.id
        ? { ...entry, pid: 456, healthStatus: "active", lastProgressAt: "2026-01-01T00:00:01.000Z" }
        : entry
    );
    fs.writeFileSync(resolveStateFile(workspace), `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
  });

  await pendingUpsert;
  const [stored] = loadState(workspace).jobs;
  assert.equal(stored.title, "renamed");
  assert.equal(stored.pid, 456);
  assert.equal(stored.healthStatus, "active");
  assert.equal(stored.lastProgressAt, "2026-01-01T00:00:01.000Z");
});
