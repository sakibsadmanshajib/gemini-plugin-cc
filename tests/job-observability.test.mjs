import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import {
  createTrackedJob,
  markTrackedJobCancelled,
  runTrackedJob,
  updateJobPhase
} from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { loadState, readJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  classifyDiagnostic,
  recordJobEvent,
  MAX_JOB_EVENTS,
  MAX_DIAGNOSTIC_LENGTH,
  __testing as jobObsTesting
} from "../plugins/gemini/scripts/lib/job-observability.mjs";
import { buildJobEventFromAcpNotification } from "../plugins/gemini/scripts/lib/gemini.mjs";

const { isDiagnosticEvent, sanitizeEvent } = jobObsTesting;

test("recordJobEvent retains bounded recent events and updates progress fields", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "observe" });

  for (let index = 0; index < MAX_JOB_EVENTS + 5; index++) {
    await recordJobEvent(workspace, job.id, {
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

test("createTrackedJob initializes queued health and an empty event list", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);

  const job = await createTrackedJob({
    workspaceRoot: workspace,
    kind: "task",
    title: "queued health",
    request: { prompt: "private prompt" }
  });

  const stored = readJobFile(workspace, job.id);
  assert.deepEqual(stored.events, []);
  assert.equal(stored.healthStatus, "queued");

  const [indexJob] = loadState(workspace).jobs;
  assert.equal(indexJob.id, job.id);
  assert.equal(indexJob.healthStatus, "queued");
  assert.equal("request" in indexJob, false);
  assert.equal(JSON.stringify(indexJob).includes("private prompt"), false);
});

test("runTrackedJob records worker start and completion events", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "complete" });

  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    threadId: "thread-1",
    turnId: "turn-1",
    payload: { ok: true },
    rendered: "done",
    summary: "done"
  }));

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.healthStatus, "completed");
  assert.deepEqual(stored.events.map((event) => event.type), ["worker_started", "completed"]);
  assert.equal(stored.events.at(-1).message, "Job completed.");
});

test("runTrackedJob start transition preserves pre-existing events", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "pre-start event" });

  await recordJobEvent(workspace, job.id, {
    type: "status",
    message: "Observer attached.",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    summary: "done"
  }));

  const stored = readJobFile(workspace, job.id);
  assert.deepEqual(stored.events.map((event) => event.type), [
    "status",
    "worker_started",
    "completed"
  ]);
});

test("runTrackedJob records failure events without swallowing the original error", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "fail" });

  await assert.rejects(
    runTrackedJob(job, async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.healthStatus, "failed");
  assert.deepEqual(stored.events.map((event) => event.type), ["worker_started", "failed"]);
  assert.equal(stored.events.at(-1).message, "boom");
});

test("updateJobPhase records phase change events", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "phase" });

  let finishRunner;
  const runnerDone = new Promise((resolve) => {
    finishRunner = resolve;
  });
  const running = runTrackedJob(job, async () => runnerDone);
  // Yield to the mutex queue so the "running" write lands first.
  await new Promise((resolve) => setImmediate(resolve));
  await updateJobPhase(workspace, job.id, "collecting_context");

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.phase, "collecting_context");
  assert.equal(stored.events.at(-1).type, "phase_changed");
  assert.equal(stored.events.at(-1).phase, "collecting_context");

  finishRunner({ exitStatus: 0, summary: "", rendered: "" });
  await running;
});

test("markTrackedJobCancelled records cancellation health and recommended action", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "cancel" });

  await markTrackedJobCancelled(workspace, job.id, {
    source: "user",
    message: "Cancelled by user request."
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.healthStatus, "cancelled");
  assert.match(stored.recommendedAction, /status|result|retry/i);
  assert.equal(stored.events.at(-1).type, "worker_cancelled");
  assert.equal(stored.events.at(-1).source, "user");

  const [indexJob] = loadState(workspace).jobs;
  assert.equal(indexJob.status, "cancelled");
  assert.equal(indexJob.healthStatus, "cancelled");
  assert.equal("events" in indexJob, false);
});

test("classifyDiagnostic recognizes quota, auth, broker, model, and network messages", () => {
  assert.equal(classifyDiagnostic("quota exceeded, retrying later").kind, "rate_limit");
  assert.equal(classifyDiagnostic("401 auth expired; login required").kind, "auth");
  assert.equal(classifyDiagnostic("Broker is busy with another request.").kind, "broker");
  assert.equal(classifyDiagnostic("model is unavailable").kind, "model");
  assert.equal(classifyDiagnostic("ECONNRESET while calling API").kind, "network");
  assert.equal(classifyDiagnostic("socket hang up while calling API").kind, "network");
  assert.equal(classifyDiagnostic("endpoint disconnected during request").kind, "network");
  assert.equal(classifyDiagnostic("retrying after transient worker issue").kind, "unknown");
});

test("recordJobEvent replaces index entries with compact observability fields", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({
    workspaceRoot: workspace,
    kind: "task",
    title: "compact",
    request: {
      prompt: "secret prompt ".repeat(100),
      rawOutput: "raw output ".repeat(100),
      stderr: "stderr ".repeat(100)
    }
  });

  await recordJobEvent(workspace, job.id, {
    type: "model_text_chunk",
    message: "hello",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  const [indexJob] = loadState(workspace).jobs;
  assert.equal(indexJob.id, job.id);
  assert.equal(indexJob.healthStatus, "active");
  assert.equal(indexJob.lastProgressAt, "2026-01-01T00:00:00.000Z");
  assert.equal("request" in indexJob, false);
  assert.equal("prompt" in indexJob, false);
  assert.equal("rawOutput" in indexJob, false);
  assert.equal("rendered" in indexJob, false);
  assert.equal("result" in indexJob, false);
  assert.equal("events" in indexJob, false);
  assert.equal(JSON.stringify(indexJob).includes("secret prompt"), false);
});

test("recordJobEvent stores only bounded safe event fields", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "safe fields" });
  const longValue = "x".repeat(MAX_DIAGNOSTIC_LENGTH + 25);

  await recordJobEvent(workspace, job.id, {
    type: "tool_call",
    timestamp: `${"2026-01-01T00:00:01.000Z".padEnd(MAX_DIAGNOSTIC_LENGTH + 25, "x")}\u0007`,
    message: longValue,
    phase: longValue,
    toolName: longValue,
    path: longValue,
    action: longValue,
    source: longValue,
    transport: longValue,
    prompt: "do not store",
    raw: "do not store",
    stdout: "do not store",
    output: "do not store",
    request: { prompt: "do not store" },
    payload: { stderr: "do not store" }
  });

  const [storedEvent] = readJobFile(workspace, job.id).events;
  assert.deepEqual(Object.keys(storedEvent).sort(), [
    "action",
    "message",
    "path",
    "phase",
    "source",
    "timestamp",
    "toolName",
    "transport",
    "type"
  ]);
  for (const key of ["message", "phase", "toolName", "path", "action", "source", "transport"]) {
    assert.equal(storedEvent[key].length, MAX_DIAGNOSTIC_LENGTH);
  }
  assert.equal(storedEvent.timestamp.length, MAX_DIAGNOSTIC_LENGTH);
  assert.equal(JSON.stringify(storedEvent).includes("do not store"), false);
  assert.equal(readJobFile(workspace, job.id).lastToolCallAt, storedEvent.timestamp);
  assert.equal(readJobFile(workspace, job.id).lastHeartbeatAt, storedEvent.timestamp);
});

test("diagnostic events update health fields with bounded sanitized messages", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "diagnostic" });
  const diagnosticText = `\u001b[31m401 auth expired\u001b[0m\u0007 ${"x".repeat(MAX_DIAGNOSTIC_LENGTH + 50)}`;

  await recordJobEvent(workspace, job.id, {
    type: "error",
    message: diagnosticText,
    timestamp: "2026-01-01T00:00:02.000Z",
    output: "do not store",
    payload: { stderr: "do not store" }
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.lastDiagnosticAt, "2026-01-01T00:00:02.000Z");
  assert.equal(stored.healthStatus, "auth_required");
  assert.match(stored.recommendedAction, /auth/i);
  assert.equal(stored.healthMessage.length, MAX_DIAGNOSTIC_LENGTH);
  assert.equal(stored.healthMessage.includes("\u001b"), false);
  assert.equal(stored.healthMessage.includes("\u0007"), false);
  assert.equal(stored.healthMessage.includes("[31m"), false);
  assert.equal(JSON.stringify(stored).includes("do not store"), false);
});

test("diagnostic sanitization strips OSC and DCS payloads", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "escape hygiene" });

  await recordJobEvent(workspace, job.id, {
    type: "diagnostic",
    message: "\u001b]0;hidden-title\u0007\u001bPprivate-payload\u001b\\401 auth expired",
    timestamp: "2026-01-01T00:00:03.000Z"
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.healthStatus, "auth_required");
  assert.match(stored.healthMessage, /401 auth expired/);
  assert.equal(stored.healthMessage.includes("hidden-title"), false);
  assert.equal(stored.healthMessage.includes("private-payload"), false);
});

test("sanitizeEvent enforces per-field value types", () => {
  const e = sanitizeEvent(
    {
      type: 1,
      timestamp: 0,
      message: true,
      phase: 2,
      chars: 42,
      final: true
    },
    "2026-04-18T00:00:00Z"
  );

  assert.deepEqual(e, {
    timestamp: "2026-04-18T00:00:00Z",
    chars: 42
  });
});

test("non-terminal events preserve terminal health", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "terminal" });

  await recordJobEvent(workspace, job.id, {
    type: "completed",
    message: "Job completed.",
    timestamp: "2026-01-01T00:00:04.000Z"
  });
  await recordJobEvent(workspace, job.id, {
    type: "diagnostic",
    message: "401 auth expired after completion",
    timestamp: "2026-01-01T00:00:05.000Z"
  });
  await recordJobEvent(workspace, job.id, {
    type: "model_text_chunk",
    chars: 12,
    timestamp: "2026-01-01T00:00:06.000Z"
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.healthStatus, "completed");
  assert.equal(stored.recommendedAction, "Run /gemini:result to inspect the completed job output.");
  assert.equal(stored.lastProgressAt, undefined);
  assert.equal(stored.lastDiagnosticAt, undefined);
});

test("progress events clear stale diagnostic recovery actions", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "recovery" });

  await recordJobEvent(workspace, job.id, {
    type: "diagnostic",
    message: "401 auth expired",
    timestamp: "2026-01-01T00:00:07.000Z"
  });
  await recordJobEvent(workspace, job.id, {
    type: "model_text_chunk",
    chars: 1,
    timestamp: "2026-01-01T00:00:08.000Z"
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.healthStatus, "active");
  assert.equal(stored.healthMessage, null);
  assert.equal(stored.recommendedAction, null);
});

test("unknown error events use cautious health status", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "unknown error" });

  await recordJobEvent(workspace, job.id, {
    type: "error",
    message: "unexpected process exit",
    timestamp: "2026-01-01T00:00:03.000Z"
  });

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.lastDiagnosticAt, "2026-01-01T00:00:03.000Z");
  assert.equal(stored.healthStatus, "possibly_stalled");
});

test("runTrackedJob completion preserves summary on the compact index", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "t" });
  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    summary: "Done.",
    threadId: "th",
    turnId: 1
  }));
  const idx = loadState(workspace).jobs.find((entry) => entry.id === job.id);
  assert.equal(idx.summary, "Done.");
});

test("runTrackedJob failure path keeps errorMessage on the compact index", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "t" });
  await runTrackedJob(job, async () => {
    throw new Error("Boom");
  }).catch(() => {});
  const idx = loadState(workspace).jobs.find((entry) => entry.id === job.id);
  assert.match(idx.errorMessage ?? "", /Boom/);
});

test("markTrackedJobCancelled returns { job, eventRecorded }", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "t" });
  const result = await markTrackedJobCancelled(workspace, job.id, { reason: "user" });
  assert.equal(typeof result, "object");
  assert.equal(result.eventRecorded, true);
  assert.equal(result.job.healthStatus, "cancelled");
});

test("buildJobEventFromAcpNotification records chars, not model text, for agent_message_chunk", () => {
  const evt = buildJobEventFromAcpNotification({
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret" } } }
  });
  assert.equal(evt.type, "model_text_chunk");
  assert.equal(evt.chars, 6);
  assert.equal(evt.message, undefined);
});

test("isDiagnosticEvent matches exact types and diagnostic prefix only", () => {
  assert.equal(isDiagnosticEvent({ type: "error_cleared" }), false);
  assert.equal(
    isDiagnosticEvent({ type: "diagnostic_acknowledged" }),
    true,
    "diagnostic_acknowledged has diagnostic_ prefix"
  );
  // The spec intent: broad includes() no longer matches "error_cleared". Exact and prefix-based only.
  assert.equal(isDiagnosticEvent({ type: "clearerror" }), false);
  assert.equal(isDiagnosticEvent({ type: "diagnostic" }), true);
  assert.equal(isDiagnosticEvent({ type: "diagnostic_quota" }), true);
});

test("sanitizeEvent passes through numeric whitelisted fields and drops non-whitelisted keys", () => {
  const e = sanitizeEvent(
    { type: "model_text_chunk", chars: 42, final: true },
    "2026-04-18T00:00:00Z"
  );
  assert.equal(e.chars, 42);
  // `final` is not in SAFE_EVENT_FIELDS; verify numeric stays and boolean is documented behaviour
  assert.equal(e.type, "model_text_chunk");
});

test("concurrent recordJobEvent calls on the same job retain all events", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "race" });

  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      recordJobEvent(workspace, job.id, {
        type: "model_text_chunk",
        message: `chunk-${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      })
    )
  );

  const stored = readJobFile(workspace, job.id);
  const observed = new Set(stored.events.map((e) => e.message));
  for (let i = 0; i < N; i++) {
    assert.ok(observed.has(`chunk-${i}`), `event chunk-${i} missing`);
  }
});

test("buildJobEventFromAcpNotification distinguishes agent_thought_chunk from agent_message_chunk", async () => {
  const messageEvent = buildJobEventFromAcpNotification({
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } }
  });
  const thoughtEvent = buildJobEventFromAcpNotification({
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning" } } }
  });
  assert.equal(messageEvent.type, "model_text_chunk");
  assert.equal(messageEvent.chars, 5);
  assert.equal(thoughtEvent.type, "model_thought_chunk");
  assert.equal(thoughtEvent.chars, 9);
  assert.equal(messageEvent.text, undefined);
  assert.equal(thoughtEvent.text, undefined);
});

test("recordJobEvent persists model_thought_chunk with only char count", async () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = await createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "thought persist" });

  await recordJobEvent(workspace, job.id, {
    type: "model_thought_chunk",
    chars: 42,
    timestamp: new Date("2026-04-18T12:00:00Z").toISOString()
  });

  const stored = readJobFile(workspace, job.id);
  const last = stored.events.at(-1);
  assert.equal(last.type, "model_thought_chunk");
  assert.equal(last.chars, 42);
  assert.equal(last.text, undefined);
});
