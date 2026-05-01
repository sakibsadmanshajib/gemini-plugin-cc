import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  defaultIsProcessAlive,
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

test("buildStatusSnapshot preserves persisted rate_limited health even with recent progress", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "sticky" });
  await setRunningJob(workspace, job, {
    healthStatus: "rate_limited",
    healthMessage: "quota exceeded",
    recommendedAction: "wait or switch models",
    lastProgressAt: iso(now - 1000),
    lastHeartbeatAt: iso(now - 1000)
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: iso(now),
    isProcessAlive: () => true
  });

  assert.equal(snapshot.running[0].healthStatus, "rate_limited");
  assert.equal(snapshot.running[0].healthMessage, "quota exceeded");
  assert.equal(snapshot.running[0].recommendedAction, "wait or switch models");
});

test("buildStatusSnapshot preserves persisted auth_required and broker_unhealthy", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  const authJob = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "auth" });
  await setRunningJob(workspace, authJob, {
    healthStatus: "auth_required",
    lastProgressAt: iso(now - 500),
    lastHeartbeatAt: iso(now - 500)
  });
  const brokerJob = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "broker" });
  await setRunningJob(workspace, brokerJob, {
    healthStatus: "broker_unhealthy",
    lastProgressAt: iso(now - 500),
    lastHeartbeatAt: iso(now - 500)
  });

  const snapshot = buildStatusSnapshot(workspace, {
    now: iso(now),
    isProcessAlive: () => true
  });

  const byId = new Map(snapshot.running.map((j) => [j.id, j]));
  assert.equal(byId.get(authJob.id).healthStatus, "auth_required");
  assert.equal(byId.get(brokerJob.id).healthStatus, "broker_unhealthy");
});

test("defaultIsProcessAlive returns false when process.kill throws EPERM", (t) => {
  const originalKill = process.kill;
  t.after(() => {
    process.kill = originalKill;
  });
  process.kill = () => {
    const err = new Error("operation not permitted");
    err.code = "EPERM";
    throw err;
  };
  // EPERM means the PID exists but is owned by another user — since
  // workers are spawned as the current user, the worker is gone and
  // the PID was recycled. Must report as dead so jobs can transition
  // to worker_missing instead of being pinned to running forever.
  assert.equal(defaultIsProcessAlive(999999), false);
});

test("defaultIsProcessAlive returns false when process.kill throws ESRCH", (t) => {
  const originalKill = process.kill;
  t.after(() => {
    process.kill = originalKill;
  });
  process.kill = () => {
    const err = new Error("no such process");
    err.code = "ESRCH";
    throw err;
  };
  assert.equal(defaultIsProcessAlive(999999), false);
});

test("defaultIsProcessAlive returns true when process.kill succeeds", (t) => {
  const originalKill = process.kill;
  t.after(() => {
    process.kill = originalKill;
  });
  process.kill = () => true;
  assert.equal(defaultIsProcessAlive(1234), true);
});

test("defaultIsProcessAlive returns true when no pid is provided", () => {
  assert.equal(defaultIsProcessAlive(null), true);
  assert.equal(defaultIsProcessAlive(undefined), true);
  assert.equal(defaultIsProcessAlive(0), true);
});

// ─── filterJobsForCurrentSession env-injection coverage ────────────────────
// Added in round-1 swarm fix-batch (Gemini HIGH gap). The function accepts
// an optional `env` argument that defaults to `process.env`. This is the
// regression vector for cross-session job leakage between Claude and Codex
// sessions sharing a workspace.

import { filterJobsForCurrentSession } from "../plugins/gemini/scripts/lib/job-control.mjs";
const SESSION_ID_ENV_VAR = "GEMINI_COMPANION_SESSION_ID";

const FILTER_SAMPLE_JOBS = [
  { id: "job-1", sessionId: "session-A", status: "completed" },
  { id: "job-2", sessionId: "session-A", status: "running" },
  { id: "job-3", sessionId: "session-B", status: "completed" },
  { id: "job-4", sessionId: null, status: "completed" }
];

test("filterJobsForCurrentSession: empty env returns all jobs (no filter)", () => {
  const result = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS, {});
  assert.equal(result.length, FILTER_SAMPLE_JOBS.length,
    "empty env (no SESSION_ID) must return all jobs unfiltered");
  assert.deepStrictEqual(result, FILTER_SAMPLE_JOBS,
    "all jobs returned unmodified when no SESSION_ID set");
});

test("filterJobsForCurrentSession: env with SESSION_ID returns only matching jobs", () => {
  const env = { [SESSION_ID_ENV_VAR]: "session-A" };
  const result = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS, env);

  assert.equal(result.length, 2, "session-A should match exactly 2 jobs");
  assert.ok(result.every((j) => j.sessionId === "session-A"),
    "every returned job must have matching sessionId");
  assert.deepStrictEqual(
    result.map((j) => j.id).sort(),
    ["job-1", "job-2"],
    "specific job IDs must match"
  );
});

test("filterJobsForCurrentSession: env with non-matching SESSION_ID returns empty array", () => {
  const env = { [SESSION_ID_ENV_VAR]: "session-NONEXISTENT" };
  const result = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS, env);

  assert.equal(result.length, 0,
    "no jobs match the unknown SESSION_ID; result must be empty");
  assert.deepStrictEqual(result, [], "result is empty array, not undefined/null");
});

test("filterJobsForCurrentSession: env arg omitted falls back to process.env", () => {
  const savedSessionId = process.env[SESSION_ID_ENV_VAR];
  delete process.env[SESSION_ID_ENV_VAR];

  try {
    const unfiltered = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS);
    assert.equal(unfiltered.length, FILTER_SAMPLE_JOBS.length,
      "default env=process.env with no SESSION_ID returns all jobs");

    process.env[SESSION_ID_ENV_VAR] = "session-B";
    const filtered = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS);
    assert.equal(filtered.length, 1, "process.env=session-B → 1 match");
    assert.equal(filtered[0].id, "job-3");
  } finally {
    if (savedSessionId === undefined) {
      delete process.env[SESSION_ID_ENV_VAR];
    } else {
      process.env[SESSION_ID_ENV_VAR] = savedSessionId;
    }
  }
});

test("filterJobsForCurrentSession: jobs with null sessionId excluded under specific filter", () => {
  // Cross-session leakage check — a job with sessionId=null (unscoped) is NOT
  // a match for any specific SESSION_ID. Otherwise unscoped jobs leak between
  // Claude and Codex sessions sharing a workspace.
  const env = { [SESSION_ID_ENV_VAR]: "session-A" };
  const result = filterJobsForCurrentSession(FILTER_SAMPLE_JOBS, env);

  assert.ok(result.every((j) => j.sessionId !== null),
    "null-sessionId (unscoped) jobs must NOT match a specific session filter");
});
