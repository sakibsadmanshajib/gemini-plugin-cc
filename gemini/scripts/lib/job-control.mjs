/**
 * Job querying, enrichment, and resolution for status/result/cancel commands.
 */

import fs from "node:fs";

import { getSessionRuntimeStatus } from "./gemini.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

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

function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const storedJob = readJobFile(job.workspaceRoot ?? process.cwd(), job.id);
  const elapsed = computeElapsed(job);

  const enriched = {
    ...job,
    elapsed,
    threadId: storedJob?.threadId ?? job.threadId ?? null,
    turnId: storedJob?.turnId ?? job.turnId ?? null,
    summary: storedJob?.summary ?? job.summary ?? null,
    errorMessage: storedJob?.errorMessage ?? null
  };

  // Add recent progress lines from log.
  if (storedJob?.logFile && fs.existsSync(storedJob.logFile)) {
    try {
      const log = fs.readFileSync(storedJob.logFile, "utf8");
      const lines = log.trim().split("\n").slice(-maxProgressLines);
      enriched.recentProgress = lines;
    } catch {
      enriched.recentProgress = [];
    }
  }

  return enriched;
}

function computeElapsed(job) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? new Date().toISOString();
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

  const running = sessionJobs.filter((j) => j.status === "running" || j.status === "queued");
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
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
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
