import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { createTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { readJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  classifyDiagnostic,
  recordJobEvent,
  MAX_JOB_EVENTS
} from "../plugins/gemini/scripts/lib/job-observability.mjs";

test("recordJobEvent retains bounded recent events and updates progress fields", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "observe" });

  for (let index = 0; index < MAX_JOB_EVENTS + 5; index++) {
    recordJobEvent(workspace, job.id, {
      type: "model_text_chunk",
      message: `chunk ${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    });
  }

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.events.length, MAX_JOB_EVENTS);
  assert.equal(stored.events[0].message, "chunk 5");
  assert.equal(stored.events.at(-1).message, `chunk ${MAX_JOB_EVENTS + 4}`);
  assert.equal(stored.healthStatus, "active");
  assert.equal(stored.lastProgressAt, stored.events.at(-1).timestamp);
  assert.equal(stored.lastModelOutputAt, stored.events.at(-1).timestamp);
});

test("classifyDiagnostic recognizes quota, auth, broker, model, and network messages", () => {
  assert.equal(classifyDiagnostic("quota exceeded, retrying later").kind, "rate_limit");
  assert.equal(classifyDiagnostic("401 auth expired; login required").kind, "auth");
  assert.equal(classifyDiagnostic("Broker is busy with another request.").kind, "broker");
  assert.equal(classifyDiagnostic("model is unavailable").kind, "model");
  assert.equal(classifyDiagnostic("ECONNRESET while calling API").kind, "network");
});
