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
