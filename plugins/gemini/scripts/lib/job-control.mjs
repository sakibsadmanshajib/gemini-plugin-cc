/**
 * Job querying, enrichment, and resolution for status/result/cancel commands.
 */

import fs from "node:fs";

import { getSessionRuntimeStatus } from "./gemini.mjs";
import { getConfig, listJobs, readJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const DEFAULT_MAX_RECENT_EVENTS = 5;
export const QUIET_AFTER_MS = 2 * 60 * 1000;
export const POSSIBLY_STALLED_AFTER_MS = 10 * 60 * 1000;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function filterJobsForCurrentSession(jobs) {
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((j) => j.sessionId === sessionId);
}

function matchJobReference(jobs, reference, filter) {
  const candidates = filter ? jobs.filter(filter) : jobs;
  if (!reference) {
    return candidates[0] ?? null;
  }

  // Exact ID match.
  const exact = candidates.find((j) => j.id === reference);
  if (exact) {
    return exact;
  }

  // Partial ID match.
  const partial = candidates.filter((j) => j.id.includes(reference));
  if (partial.length === 1) {
    return partial[0];
  }

  // Numeric index (1-based).
  const idx = Number(reference);
  if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
    return candidates[idx - 1];
  }

  return null;
}

function defaultIsProcessAlive(pid) {
  if (!pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseTime(value) {
  const ms = new Date(value ?? "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function classifyRuntimeHealth(job, options = {}) {
  if (job.status !== "running" && job.status !== "queued") {
    return {};
  }

  const nowMs = parseTime(options.now) ?? Date.now();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (job.pid && !isProcessAlive(job.pid)) {
    return {
      healthStatus: "worker_missing",
      healthMessage: "Worker process is no longer running.",
      recommendedAction: "Check /gemini:result or /gemini:status, then retry if the result is incomplete."
    };
  }

  const lastProgressMs = parseTime(job.lastProgressAt);
  if (lastProgressMs !== null && nowMs - lastProgressMs <= QUIET_AFTER_MS) {
    return {
      healthStatus: "active",
      healthMessage: job.healthMessage ?? null,
      recommendedAction: job.recommendedAction ?? null
    };
  }

  const lastHeartbeatMs = parseTime(job.lastHeartbeatAt);
  if (lastHeartbeatMs !== null && nowMs - lastHeartbeatMs <= POSSIBLY_STALLED_AFTER_MS) {
    return {
      healthStatus: "quiet",
      healthMessage: "Worker heartbeat is recent, but no progress was recorded recently.",
      recommendedAction: "Check status again shortly or inspect the detailed job status."
    };
  }

  if (lastProgressMs !== null || lastHeartbeatMs !== null || job.status === "running") {
    return {
      healthStatus: "possibly_stalled",
      healthMessage: "No recent worker heartbeat or progress was recorded.",
      recommendedAction: "Check /gemini:status or /gemini:result, then retry if the job does not recover."
    };
  }

  return {};
}

function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const maxRecentEvents = options.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS;
  const storedJob = readJobFile(job.workspaceRoot ?? process.cwd(), job.id);
  const source = storedJob ? { ...job, ...storedJob } : job;
  const elapsed = computeElapsed(source, options.now);
  const runtimeHealth = classifyRuntimeHealth(source, options);

  const enriched = {
    ...source,
    request: undefined,
    result: undefined,
    rendered: undefined,
    elapsed,
    threadId: source.threadId ?? null,
    turnId: source.turnId ?? null,
    summary: source.summary ?? null,
    errorMessage: source.errorMessage ?? null,
    events: Array.isArray(source.events) ? source.events.slice(-maxRecentEvents) : [],
    healthStatus: runtimeHealth.healthStatus ?? source.healthStatus ?? null,
    healthMessage: runtimeHealth.healthMessage ?? source.healthMessage ?? null,
    recommendedAction: runtimeHealth.recommendedAction ?? source.recommendedAction ?? null,
    lastHeartbeatAt: source.lastHeartbeatAt ?? null,
    lastProgressAt: source.lastProgressAt ?? null,
    lastModelOutputAt: source.lastModelOutputAt ?? null,
    lastToolCallAt: source.lastToolCallAt ?? null,
    lastDiagnosticAt: source.lastDiagnosticAt ?? null
  };

  // Add recent progress lines from log.
  if (source?.logFile && fs.existsSync(source.logFile)) {
    try {
      const log = fs.readFileSync(source.logFile, "utf8");
      const lines = log.trim().split("\n").slice(-maxProgressLines);
      enriched.recentProgress = lines;
    } catch {
      enriched.recentProgress = [];
    }
  }

  return enriched;
}

function computeElapsed(job, now = new Date().toISOString()) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? now;
  if (!start) {
    return null;
  }
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60000)}m`;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const sessionJobs = filterJobsForCurrentSession(allJobs);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;

  const running = sessionJobs
    .filter((j) => j.status === "running" || j.status === "queued")
    .map((j) =>
      enrichJob(j, {
        maxProgressLines: options.maxProgressLines,
        maxRecentEvents: options.maxRecentEvents,
        now: options.now,
        isProcessAlive: options.isProcessAlive
      })
    );
  const recent = sessionJobs
    .filter((j) => j.status !== "running" && j.status !== "queued")
    .slice(0, maxJobs);
  const latestFinished = recent[0] ?? null;

  return {
    workspaceRoot,
    config,
    runtimeStatus: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /gemini:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, {
      maxProgressLines: options.maxProgressLines,
      maxRecentEvents: options.maxRecentEvents,
      now: options.now,
      isProcessAlive: options.isProcessAlive
    })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot))
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "running" || job.status === "queued");
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Run /gemini:status ${active.id} to check progress, or /gemini:status ${active.id} --wait to wait.`
    );
  }

  if (reference) {
    throw new Error(`No job found for "${reference}". Run /gemini:status to inspect active jobs.`);
  }

  throw new Error("No finished Gemini jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");

  if (activeJobs.length === 0) {
    throw new Error("No active Gemini jobs to cancel.");
  }

  const selected = matchJobReference(activeJobs, reference);
  if (!selected) {
    const ids = activeJobs.map((j) => j.id).join(", ");
    throw new Error(`No active job matched "${reference}". Active jobs: ${ids}`);
  }

  return { workspaceRoot, job: selected };
}
