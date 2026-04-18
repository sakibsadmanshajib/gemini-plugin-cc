import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  POSSIBLY_STALLED_AFTER_MS,
  QUIET_AFTER_MS
} from "../plugins/gemini/scripts/lib/job-control.mjs";
import { recordJobEvent } from "../plugins/gemini/scripts/lib/job-observability.mjs";
import { createTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobLogFile, writeJobFile } from "../plugins/gemini/scripts/lib/state.mjs";

function iso(ms) {
  return new Date(ms).toISOString();
}

async function setRunningJob(workspace, job, patch = {}) {
  const stored = {
    ...readJobFile(workspace, job.id),
    status: "running",
    phase: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: 12345,
    ...patch
  };
  await writeJobFile(workspace, job.id, stored);
  await recordJobEvent(workspace, job.id, {
    type: "status",
    message: "running",
    timestamp: stored.lastProgressAt ?? "2026-01-01T00:00:01.000Z"
  });
  await writeJobFile(workspace, job.id, { ...readJobFile(workspace, job.id), ...patch });
}

test("buildStatusSnapshot enriches active jobs with health, timestamps, events, and runtime", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "active health" });
  await setRunningJob(workspace, job, {
    healthStatus: "active",
    healthMessage: "processing",
    recommendedAction: "Wait for the next update.",
    lastProgressAt: "2026-01-01T00:00:05.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:05.000Z"
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: "2026-01-01T00:00:06.000Z",
    isProcessAlive: () => true
  });

  assert.equal(snapshot.running.length, 1);
  assert.equal(snapshot.running[0].healthStatus, "active");
  assert.equal(snapshot.running[0].healthMessage, "processing");
  assert.equal(snapshot.running[0].recommendedAction, "Wait for the next update.");
  assert.equal(snapshot.running[0].lastProgressAt, "2026-01-01T00:00:05.000Z");
  assert.equal(snapshot.running[0].lastHeartbeatAt, "2026-01-01T00:00:05.000Z");
  assert.equal(snapshot.running[0].events.at(-1).type, "status");
  assert.equal(snapshot.running[0].elapsed, "6s");
});

test("buildSingleJobSnapshot includes recent events and bounded progress log tail", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "detail" });
  const logFile = resolveJobLogFile(workspace, job.id);
  fs.writeFileSync(logFile, "one\ntwo\nthree\n", "utf8");

  for (let index = 0; index < 6; index++) {
    await recordJobEvent(workspace, job.id, {
      type: "status",
      message: `event ${index}`,
      timestamp: `2026-01-01T00:00:0${index}.000Z`
    });
  }

  const snapshot = buildSingleJobSnapshot(workspace, job.id, {
    maxProgressLines: 2,
    maxRecentEvents: 3,
    now: "2026-01-01T00:00:10.000Z"
  });

  assert.deepEqual(snapshot.job.recentProgress, ["two", "three"]);
  assert.deepEqual(snapshot.job.events.map((event) => event.message), ["event 3", "event 4", "event 5"]);
});

test("buildStatusSnapshot classifies running jobs with missing workers", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "missing worker" });
  await setRunningJob(workspace, job, {
    pid: 98765,
    lastProgressAt: "2026-01-01T00:00:05.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:05.000Z"
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: "2026-01-01T00:00:06.000Z",
    isProcessAlive: () => false
  });

  assert.equal(snapshot.running[0].healthStatus, "worker_missing");
  assert.match(snapshot.running[0].recommendedAction, /result|status|retry/i);
});

test("buildStatusSnapshot keeps recent progress active", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "recent progress" });
  await setRunningJob(workspace, job, {
    lastProgressAt: iso(now - QUIET_AFTER_MS + 1000),
    lastHeartbeatAt: iso(now - QUIET_AFTER_MS + 1000)
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: iso(now),
    isProcessAlive: () => true
  });

  assert.equal(snapshot.running[0].healthStatus, "active");
});

test("buildStatusSnapshot classifies missing recent progress with heartbeat as quiet", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "quiet" });
  await setRunningJob(workspace, job, {
    lastProgressAt: iso(now - QUIET_AFTER_MS - 1000),
    lastHeartbeatAt: iso(now - POSSIBLY_STALLED_AFTER_MS + 1000)
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: iso(now),
    isProcessAlive: () => true
  });

  assert.equal(snapshot.running[0].healthStatus, "quiet");
});

test("buildStatusSnapshot classifies stale heartbeat and progress as possibly stalled", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "stalled" });
  await setRunningJob(workspace, job, {
    lastProgressAt: iso(now - POSSIBLY_STALLED_AFTER_MS - 1000),
    lastHeartbeatAt: iso(now - POSSIBLY_STALLED_AFTER_MS - 1000)
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: iso(now),
    isProcessAlive: () => true
  });

  assert.equal(snapshot.running[0].healthStatus, "possibly_stalled");
});
