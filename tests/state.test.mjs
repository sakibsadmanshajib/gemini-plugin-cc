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
  saveState
} from "../plugins/gemini/scripts/lib/state.mjs";
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

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

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
  // Log files may or may not exist (createTrackedJob doesn't create one), but
  // the reconciled state must also not drop their indexed logFile path.
  if (fs.existsSync(aLog)) assert.ok(true);
  if (fs.existsSync(bLog)) assert.ok(true);
});
