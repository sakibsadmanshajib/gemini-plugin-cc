import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderResultOutput,
  renderSingleJobStatus,
  renderStatusSnapshot
} from "../plugins/gemini/scripts/lib/render.mjs";

test("renderReviewResult renders an approve verdict with no findings", () => {
  const output = renderReviewResult({
    verdict: "approve",
    summary: "Looks fine.",
    findings: [],
    next_steps: []
  });

  assert.match(output, /Gemini Adversarial Review/);
  assert.match(output, /APPROVED/);
  assert.match(output, /Looks fine\./);
  assert.match(output, /No material findings\./);
});

test("renderReviewResult renders findings sorted by severity", () => {
  const output = renderReviewResult({
    verdict: "needs-attention",
    summary: "One issue found.",
    findings: [
      {
        severity: "low",
        title: "Minor style",
        body: "Nit.",
        file: "a.js",
        line_start: 1,
        line_end: 2,
        confidence: 0.5,
        recommendation: "Optional fix."
      },
      {
        severity: "critical",
        title: "SQL injection",
        body: "Unsanitized input.",
        file: "db.js",
        line_start: 10,
        line_end: 15,
        confidence: 0.95,
        recommendation: "Parameterize query."
      }
    ],
    next_steps: ["Fix the injection."]
  });

  assert.match(output, /NEEDS ATTENTION/);
  assert.match(output, /Findings \(2\)/);
  const criticalIdx = output.indexOf("CRITICAL");
  const lowIdx = output.indexOf("LOW");
  assert.ok(criticalIdx < lowIdx, "Critical findings should appear before low severity");
  assert.match(output, /SQL injection/);
  assert.match(output, /Next Steps/);
});

test("renderResultOutput includes session ID and resume command for raw output", () => {
  const output = renderResultOutput(
    "/tmp/test-workspace",
    {
      id: "gemini-123",
      status: "completed",
      kind: "task",
      title: "Gemini Task"
    },
    {
      threadId: "sess-abc-123",
      result: {
        rawOutput: "Task completed successfully."
      }
    }
  );

  assert.match(output, /Task completed successfully\./);
  assert.match(output, /Gemini session ID: sess-abc-123/);
  assert.match(output, /Resume in Gemini: gemini --resume sess-abc-123/);
});

test("renderResultOutput uses pre-rendered output when no rawOutput is present", () => {
  const output = renderResultOutput(
    "/tmp/test-workspace",
    {
      id: "gemini-456",
      status: "completed",
      kind: "review",
      title: "Gemini Adversarial Review"
    },
    {
      threadId: "sess-def-456",
      rendered: "# Gemini Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {}
    }
  );

  assert.match(output, /^# Gemini Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Gemini session ID: sess-def-456/);
  assert.match(output, /Resume in Gemini: gemini --resume sess-def-456/);
});

test("renderStatusSnapshot includes health and last progress for active jobs", () => {
  const output = renderStatusSnapshot({
    workspaceRoot: "/tmp/test-workspace",
    config: {},
    runtimeStatus: {},
    needsReview: false,
    latestFinished: null,
    recent: [],
    running: [
      {
        id: "gemini-789",
        kind: "task",
        status: "running",
        phase: "collecting_context",
        startedAt: "2026-01-01T00:00:00.000Z",
        healthStatus: "quiet",
        lastProgressAt: "2026-01-01T00:01:00.000Z",
        summary: "Working"
      }
    ]
  });

  assert.match(output, /\| Job ID \| Kind \| Status \| Phase \| Health \| Last Progress \| Elapsed \| Summary \|/);
  assert.match(output, /quiet/);
  assert.match(output, /2026-01-01T00:01:00.000Z/);
});

test("renderSingleJobStatus includes observability details without raw event payloads", () => {
  const output = renderSingleJobStatus({
    workspaceRoot: "/tmp/test-workspace",
    job: {
      id: "gemini-detail",
      kind: "task",
      status: "running",
      phase: "running",
      title: "Detailed status",
      elapsed: "2m",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:01:00.000Z",
      lastProgressAt: "2026-01-01T00:00:45.000Z",
      lastDiagnosticAt: "2026-01-01T00:00:50.000Z",
      healthStatus: "quiet",
      healthMessage: "No model output recently.",
      recommendedAction: "Check status again or retry if it remains quiet.",
      pid: 123,
      events: [
        {
          type: "tool_call",
          timestamp: "2026-01-01T00:00:30.000Z",
          message: "reading files",
          toolName: "read_file",
          payload: { raw: "do not render" }
        },
        {
          type: "diagnostic",
          timestamp: "2026-01-01T00:00:50.000Z",
          message: "No model output recently."
        }
      ],
      recentProgress: ["progress line"]
    }
  });

  assert.match(output, /## Health/);
  assert.match(output, /- \*\*Health:\*\* quiet/);
  assert.match(output, /- \*\*Diagnostic:\*\* No model output recently\./);
  assert.match(output, /- \*\*Recommended Action:\*\* Check status again or retry if it remains quiet\./);
  assert.match(output, /## Runtime/);
  assert.match(output, /- \*\*PID:\*\* 123/);
  assert.match(output, /- \*\*Started:\*\* 2026-01-01T00:00:00.000Z/);
  assert.match(output, /## Recent Events/);
  assert.match(output, /tool_call/);
  assert.match(output, /read_file/);
  assert.doesNotMatch(output, /payload/);
  assert.doesNotMatch(output, /do not render/);
});

test("renderSingleJobStatus includes runtime.transport when present", () => {
  const output = renderSingleJobStatus({
    workspaceRoot: "/tmp/test-workspace",
    job: {
      id: "gemini-transport",
      kind: "task",
      status: "running",
      title: "Transport rendering",
      elapsed: "1m",
      startedAt: "2026-01-01T00:00:00.000Z",
      runtime: { transport: "broker" },
      events: []
    }
  });
  assert.match(output, /## Runtime/);
  assert.match(output, /- \*\*Transport:\*\* broker/);
});

test("renderSingleJobStatus includes tail of recent events and counters", () => {
  const now = Date.parse("2026-04-18T12:00:10.000Z");
  const job = {
    id: "job_abc",
    kind: "task",
    status: "running",
    title: "observing",
    startedAt: "2026-04-18T12:00:00.000Z",
    events: [
      { type: "phase", message: "session_created", timestamp: "2026-04-18T12:00:01.000Z" },
      { type: "tool_call", toolName: "read_file", timestamp: "2026-04-18T12:00:02.000Z" },
      { type: "model_text_chunk", chars: 140, timestamp: "2026-04-18T12:00:03.000Z" },
      { type: "model_thought_chunk", chars: 62, timestamp: "2026-04-18T12:00:04.000Z" },
      { type: "model_text_chunk", chars: 85, timestamp: "2026-04-18T12:00:05.000Z" },
      { type: "file_change", path: "a.mjs", action: "write", timestamp: "2026-04-18T12:00:06.000Z" },
      { type: "tool_call", toolName: "write_file", timestamp: "2026-04-18T12:00:07.000Z" },
      { type: "model_text_chunk", chars: 22, timestamp: "2026-04-18T12:00:08.000Z" }
    ]
  };

  const rendered = renderSingleJobStatus(job, { now });

  assert.match(rendered, /model_text_chunk.*22/);
  assert.match(rendered, /tool_call.*write_file/);
  assert.match(rendered, /file_change.*write.*a\.mjs/);
  assert.match(rendered, /chunks=3/);
  assert.match(rendered, /thoughts=1/);
  assert.match(rendered, /tools=2/);
  assert.match(rendered, /files=1/);
  assert.match(rendered, /last event.*(ms|s) ago/i);
  assert.doesNotMatch(rendered, /session_created/);
  assert.doesNotMatch(rendered, /read_file/);
});

test("renderSingleJobStatus keeps event-tail details for phase changes and diagnostics", () => {
  const now = Date.parse("2026-04-18T12:00:10.000Z");
  const rendered = renderSingleJobStatus({
    id: "job_events",
    kind: "task",
    status: "running",
    title: "event formatting",
    startedAt: "2026-04-18T12:00:00.000Z",
    events: [
      { type: "phase_changed", phase: "running", timestamp: "2026-04-18T12:00:06.000Z" },
      { type: "diagnostic", message: "rate limit near", timestamp: "2026-04-18T12:00:07.000Z" },
      { type: "diagnostic", source: "broker", message: "connected", timestamp: "2026-04-18T12:00:08.000Z" },
      { type: "stderr", message: "warning text", timestamp: "2026-04-18T12:00:09.000Z" },
      { type: "error", source: "gemini", message: "boom", timestamp: "2026-04-18T12:00:10.000Z" }
    ]
  }, { now });

  assert.match(rendered, /\[phase_changed\] running/);
  assert.match(rendered, /\[diagnostic\] rate limit near/);
  assert.doesNotMatch(rendered, /unknown:/);
  assert.match(rendered, /\[diagnostic\] broker: connected/);
  assert.match(rendered, /\[stderr\] warning text/);
  assert.match(rendered, /\[error\] gemini: boom/);
});

test("renderSingleJobStatus falls back to phase-only rendering when events is missing", () => {
  const job = {
    id: "job_fallback",
    kind: "task",
    status: "running",
    title: "no events",
    startedAt: "2026-04-18T12:00:00.000Z",
    phase: "running"
  };

  const rendered = renderSingleJobStatus(job);
  assert.match(rendered, /job_fallback/);
  assert.doesNotMatch(rendered, /recent:/);
});
