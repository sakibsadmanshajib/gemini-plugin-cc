import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderResultOutput } from "../plugins/gemini/scripts/lib/render.mjs";

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
