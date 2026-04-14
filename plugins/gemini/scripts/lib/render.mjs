/**
 * Output rendering — formats reviews, status, results, and reports as markdown.
 */

/**
 * Render a structured review result (from adversarial review) as markdown.
 *
 * @param {{ verdict: string, summary: string, findings: Array<{ severity: string, title: string, body: string, file: string, line_start: number, line_end: number, confidence: number, recommendation: string }>, next_steps: string[] }} review
 * @returns {string}
 */
export function renderReviewResult(review) {
  const lines = [];
  const icon = review.verdict === "approve" ? "APPROVED" : "NEEDS ATTENTION";
  lines.push(`# Gemini Adversarial Review: ${icon}`);
  lines.push("");
  lines.push(`**Verdict:** ${review.verdict}`);
  lines.push(`**Summary:** ${review.summary}`);

  if (review.findings.length === 0) {
    lines.push("");
    lines.push("No material findings.");
  } else {
    lines.push("");
    lines.push(`## Findings (${review.findings.length})`);
    lines.push("");

    // Sort by severity: critical > high > medium > low.
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...review.findings].sort(
      (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
    );

    for (const finding of sorted) {
      const conf = Math.round(finding.confidence * 100);
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title} (${conf}% confidence)`);
      lines.push("");
      lines.push(`**File:** \`${finding.file}\` lines ${finding.line_start}-${finding.line_end}`);
      lines.push("");
      lines.push(finding.body);
      if (finding.recommendation) {
        lines.push("");
        lines.push(`**Recommendation:** ${finding.recommendation}`);
      }
      lines.push("");
    }
  }

  if (review.next_steps.length > 0) {
    lines.push("## Next Steps");
    lines.push("");
    for (const step of review.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a status snapshot as markdown.
 *
 * @param {{ workspaceRoot: string, config: any, runtimeStatus: any, running: any[], latestFinished: any, recent: any[], needsReview: boolean }} snapshot
 * @returns {string}
 */
export function renderStatusSnapshot(snapshot) {
  const lines = [];
  lines.push("# Gemini Status");
  lines.push("");

  // Review gate status.
  const gateStatus = snapshot.needsReview ? "enabled" : "disabled";
  lines.push(`Review gate: ${gateStatus}`);
  lines.push("");

  // Running jobs.
  if (snapshot.running.length > 0) {
    lines.push("## Active Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Phase | Elapsed | Summary |");
    lines.push("|--------|------|--------|-------|---------|---------|");
    for (const job of snapshot.running) {
      const elapsed = computeElapsedDisplay(job);
      lines.push(`| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${elapsed} | ${job.summary ?? "-"} |`);
    }
    lines.push("");
  }

  // Recent completed jobs.
  if (snapshot.recent.length > 0) {
    lines.push("## Recent Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Duration | Summary | Follow-up |");
    lines.push("|--------|------|--------|----------|---------|-----------|");
    for (const job of snapshot.recent) {
      const duration = computeElapsedDisplay(job);
      const followUp = job.status === "completed" ? `/gemini:result ${job.id}` : "-";
      lines.push(`| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${duration} | ${job.summary ?? "-"} | ${followUp} |`);
    }
    lines.push("");
  }

  if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
    lines.push("No Gemini jobs found for this session.");
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a single job's detailed status.
 *
 * @param {{ job: any }} snapshot
 * @returns {string}
 */
export function renderSingleJobStatus(snapshot) {
  const job = snapshot.job;
  const lines = [];
  lines.push(`# Gemini Job: ${job.id}`);
  lines.push("");
  lines.push(`- **Kind:** ${job.kind ?? "unknown"}`);
  lines.push(`- **Status:** ${job.status}`);
  lines.push(`- **Phase:** ${job.phase ?? "-"}`);
  lines.push(`- **Title:** ${job.title ?? "-"}`);
  if (job.elapsed) {
    lines.push(`- **Elapsed:** ${job.elapsed}`);
  }
  if (job.threadId) {
    lines.push(`- **Session ID:** ${job.threadId}`);
  }
  if (job.summary) {
    lines.push(`- **Summary:** ${job.summary}`);
  }
  if (job.errorMessage) {
    lines.push("");
    lines.push("## Error");
    lines.push("");
    lines.push(job.errorMessage);
  }

  if (job.recentProgress && job.recentProgress.length > 0) {
    lines.push("");
    lines.push("## Recent Progress");
    lines.push("");
    for (const line of job.recentProgress) {
      lines.push(line);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a stored job result for the /gemini:result command.
 *
 * @param {string} cwd
 * @param {any} job - The job index entry.
 * @param {any} storedJob - The full stored job file data.
 * @returns {string}
 */
export function renderResultOutput(cwd, job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `gemini --resume ${threadId}` : null;

  // If there's raw text output, return it.
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.gemini?.stdout === "string" && storedJob.result.gemini.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGemini session ID: ${threadId}\nResume in Gemini: ${resumeCommand}\n`;
  }

  // If there's pre-rendered output, return it.
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nGemini session ID: ${threadId}\nResume in Gemini: ${resumeCommand}\n`;
  }

  // Fallback: build from job metadata.
  const lines = [
    `# ${job.title ?? "Gemini Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Gemini session ID: ${threadId}`);
    lines.push(`Resume in Gemini: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a cancel report.
 *
 * @param {any} job
 * @returns {string}
 */
export function renderCancelReport(job) {
  const lines = [
    "# Gemini Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.kind) {
    lines.push(`- Kind: ${job.kind}`);
  }
  lines.push(`- Status: ${job.status}`);

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a setup report.
 *
 * @param {{ geminiAvailable: boolean, geminiVersion?: string, authenticated?: boolean, authMethod?: string, npmAvailable?: boolean, reviewGate?: boolean, message?: string }} report
 * @returns {string}
 */
export function renderSetupReport(report) {
  const lines = [];
  lines.push("# Gemini Setup");
  lines.push("");

  if (report.geminiAvailable) {
    lines.push(`- Gemini CLI: installed${report.geminiVersion ? ` (${report.geminiVersion})` : ""}`);
  } else {
    lines.push("- Gemini CLI: **not installed**");
  }

  if (report.authenticated !== undefined) {
    lines.push(`- Authentication: ${report.authenticated ? "authenticated" : "**not authenticated**"}`);
    if (report.authMethod) {
      lines.push(`- Auth method: ${report.authMethod}`);
    }
  }

  if (report.npmAvailable !== undefined) {
    lines.push(`- npm: ${report.npmAvailable ? "available" : "not available"}`);
  }

  if (report.reviewGate !== undefined) {
    lines.push(`- Review gate: ${report.reviewGate ? "enabled" : "disabled"}`);
  }

  if (report.message) {
    lines.push("");
    lines.push(report.message);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Output either JSON or rendered markdown based on the --json flag.
 *
 * @param {any} payload - The structured data.
 * @param {string} rendered - The markdown rendering.
 * @param {boolean} json - Whether to output JSON.
 */
export function outputCommandResult(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

function computeElapsedDisplay(job) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? new Date().toISOString();
  if (!start) {
    return "-";
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
