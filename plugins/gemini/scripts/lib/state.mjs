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
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
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

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  // Remove job files for pruned jobs.
  const nextJobIds = new Set(nextJobs.map((j) => j.id));
  for (const prevJob of previousJobs) {
    if (!nextJobIds.has(prevJob.id)) {
      removeFileIfExists(resolveJobFile(cwd, prevJob.id));
      removeFileIfExists(resolveJobLogFile(cwd, prevJob.id));
    }
  }

  fs.writeFileSync(resolveStateFile(cwd), JSON.stringify(nextState, null, 2), "utf8");
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, patch) {
  const state = loadState(cwd);
  state.config = { ...state.config, ...patch };
  saveState(cwd, state);
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function upsertJob(cwd, job) {
  const state = loadState(cwd);
  const index = state.jobs.findIndex((j) => j.id === job.id);
  const now = new Date().toISOString();
  const updated = { ...job, updatedAt: now };

  if (index >= 0) {
    state.jobs[index] = { ...state.jobs[index], ...updated };
  } else {
    state.jobs.push({ ...updated, createdAt: now });
  }

  saveState(cwd, state);
}

export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeJobFile(cwd, jobId, data) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, jobId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function appendJobLog(cwd, jobId, line) {
  ensureStateDir(cwd);
  const logPath = resolveJobLogFile(cwd, jobId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, "utf8");
}

export function readJobLog(cwd, jobId) {
  const logPath = resolveJobLogFile(cwd, jobId);
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}
