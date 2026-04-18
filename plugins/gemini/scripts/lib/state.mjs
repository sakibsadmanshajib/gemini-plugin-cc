/**
 * Job state persistence. Stores job metadata and results in a workspace-specific
 * directory tree.
 *
 * Directory layout:
 *   <stateRoot>/<slug>-<hash>/
 *     state.json        — global config + job index
 *     jobs/
 *       <job-id>.json   — full job record
 *       <job-id>.log    — timestamped progress log
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withJobMutex, withWorkspaceMutex, writeJsonAtomic } from "./atomic-state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const BROKER_SESSION_FILE = "broker-session.json";
const MAX_JOBS = 50;

function slugify(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function hashPath(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function stateRootDir() {
  return process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const slug = slugify(path.basename(root));
  const hash = hashPath(root);
  return path.join(stateRootDir(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveBrokerSessionFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_SESSION_FILE);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      }
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Reconcile a caller-supplied state snapshot with the current on-disk state.
 *
 * Rules:
 * - Jobs from the current on-disk state are preserved (so a stale caller
 *   snapshot cannot silently drop another writer's in-flight job).
 * - Jobs in the incoming snapshot overwrite fields for matching ids.
 * - The resulting job list is then capped to MAX_JOBS by most-recent
 *   `updatedAt`, matching the previous pruning behavior.
 */
function reconcileState(current, incoming) {
  const byId = new Map();
  for (const job of current.jobs ?? []) {
    if (job && job.id) byId.set(job.id, job);
  }
  for (const job of incoming?.jobs ?? []) {
    if (!job || !job.id) continue;
    const prev = byId.get(job.id);
    byId.set(job.id, prev ? { ...prev, ...job } : job);
  }
  const cappedJobs = pruneJobs(Array.from(byId.values()));

  return {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(current.config ?? {}),
      ...(incoming?.config ?? {})
    },
    jobs: cappedJobs
  };
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  // Re-load current on-disk state inside the mutex so we reconcile against
  // the freshest snapshot and never unlink another writer's files.
  const current = loadState(cwd);
  const nextState = reconcileState(current, state);

  writeJsonAtomic(resolveStateFile(cwd), nextState);

  // Prune job artifacts only for jobs that were dropped by reconciliation
  // (i.e. the MAX_JOBS cap). Jobs absent from the caller's snapshot but
  // still present in `current` are retained by `reconcileState`, so they
  // will survive here.
  const retainedIds = new Set(nextState.jobs.map((j) => j.id));
  for (const prevJob of current.jobs ?? []) {
    if (!retainedIds.has(prevJob.id)) {
      removeFileIfExists(resolveJobFile(cwd, prevJob.id));
      removeFileIfExists(resolveJobLogFile(cwd, prevJob.id));
    }
  }
}

export async function saveState(cwd, state) {
  return withWorkspaceMutex(cwd, async () => {
    saveStateUnlocked(cwd, state);
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export async function setConfig(cwd, patch) {
  return withWorkspaceMutex(cwd, async () => {
    const state = loadState(cwd);
    state.config = { ...state.config, ...patch };
    saveStateUnlocked(cwd, state);
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export async function upsertJob(cwd, job) {
  return withWorkspaceMutex(cwd, async () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex((j) => j.id === job.id);
    const now = new Date().toISOString();
    const updated = { ...job, updatedAt: now };

    if (index >= 0) {
      state.jobs[index] = { ...state.jobs[index], ...updated };
    } else {
      state.jobs.push({ ...updated, createdAt: now });
    }

    saveStateUnlocked(cwd, state);
  });
}

export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Internal atomic write. Callers are responsible for holding the per-job
 * mutex; exposed so higher-level helpers that already hold the mutex (e.g.
 * `recordJobEvent`) can persist without re-acquiring.
 */
export function writeJobFileUnlocked(cwd, jobId, data) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, jobId);
  writeJsonAtomic(filePath, data);
}

export async function writeJobFile(cwd, jobId, data) {
  return withJobMutex(cwd, jobId, async () => {
    writeJobFileUnlocked(cwd, jobId, data);
  });
}

export function appendJobLog(cwd, jobId, line) {
  ensureStateDir(cwd);
  const logPath = resolveJobLogFile(cwd, jobId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readJobLog(cwd, jobId) {
  const logPath = resolveJobLogFile(cwd, jobId);
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}
