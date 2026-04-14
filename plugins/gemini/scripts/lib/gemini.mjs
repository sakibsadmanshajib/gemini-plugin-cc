/**
 * Core Gemini functions — availability checks, auth status, running prompts,
 * reviews, and tasks through ACP.
 *
 * This mirrors the Codex plugin's codex.mjs but uses Gemini's ACP protocol
 * (JSON-RPC 2.0 via `gemini --acp`) instead of Codex's app-server.
 */

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, GeminiAcpClient } from "./acp-client.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { collectReviewContext } from "./git.mjs";
import { loadPrompt } from "./prompts.mjs";

/**
 * @typedef {{
 *   onProgress?: (message: string) => void
 * }} ProgressReporter
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   text: string,
 *   model: string | null,
 *   usage: { promptTokens: number, completionTokens: number, totalTokens: number } | null,
 *   toolCalls: Array<{ name: string, arguments: Record<string, unknown>, result?: string }>,
 *   fileChanges: Array<{ path: string, action: string }>,
 *   error: unknown
 * }} TurnResult
 */

// ─── Availability & Auth ──────────────────────────────────────────────────────

/**
 * Check whether the Gemini CLI binary is available on PATH.
 *
 * @returns {{ available: boolean, version: string | null }}
 */
export function getGeminiAvailability() {
  const available = binaryAvailable("gemini");
  if (!available) {
    return { available: false, version: null };
  }

  const result = runCommand("gemini", ["--version"]);
  const version = result.status === 0 ? result.stdout.trim() : null;
  return { available: true, version };
}

/**
 * Check Gemini authentication status.
 * Tries to connect via ACP and call authenticate, falling back to env var check.
 *
 * @param {string} cwd
 * @returns {Promise<{ authenticated: boolean, method: string | null }>}
 */
export async function getGeminiAuthStatus(cwd) {
  // Quick check: if GEMINI_API_KEY is set, we're authenticated.
  if (process.env.GEMINI_API_KEY) {
    return { authenticated: true, method: "api_key" };
  }

  if (process.env.GOOGLE_API_KEY) {
    return { authenticated: true, method: "google_api_key" };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { authenticated: true, method: "service_account" };
  }

  // Try ACP authenticate method.
  try {
    const client = await GeminiAcpClient.connect(cwd, { disableBroker: true });
    try {
      const result = await client.request("authenticate", {});
      return {
        authenticated: result?.authenticated ?? false,
        method: result?.method ?? null
      };
    } finally {
      await client.close();
    }
  } catch {
    return { authenticated: false, method: null };
  }
}

/**
 * Get the runtime status of the current session (broker status).
 *
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} cwd
 * @returns {{ brokerRunning: boolean, endpoint: string | null }}
 */
export function getSessionRuntimeStatus(env, cwd) {
  const session = loadBrokerSession(cwd);
  const endpoint = session?.endpoint ?? env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
  return {
    brokerRunning: Boolean(session),
    endpoint
  };
}

// ─── ACP Operations ───────────────────────────────────────────────────────────

/**
 * Run a prompt through Gemini ACP and capture the result.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ model?: string, thinkingBudget?: number, approvalMode?: string, sessionId?: string, env?: NodeJS.ProcessEnv, onNotification?: (n: any) => void }} [options]
 * @returns {Promise<TurnResult>}
 */
export async function runAcpPrompt(cwd, prompt, options = {}) {
  const client = await GeminiAcpClient.connect(cwd, {
    env: options.env,
    onNotification: options.onNotification
  });

  try {
    // Set approval mode if requested.
    if (options.approvalMode) {
      await client.request("setSessionMode", {
        approvalMode: options.approvalMode
      });
    }

    // Set model if requested.
    if (options.model) {
      try {
        await client.request("unstable_setSessionModel", {
          model: options.model
        });
      } catch (error) {
        process.stderr.write(`Warning: could not set model to ${options.model}: ${error?.message ?? error}\n`);
      }
    }

    // Create or load session.
    let sessionId = options.sessionId ?? null;
    if (sessionId) {
      await client.request("loadSession", { sessionId });
    } else {
      const session = await client.request("newSession", {
        approvalMode: options.approvalMode ?? "auto_edit"
      });
      sessionId = session?.sessionId ?? null;
    }

    // Send prompt.
    const result = await client.request("prompt", {
      text: prompt,
      sessionId,
      model: options.model ?? undefined
    });

    return {
      sessionId: result?.sessionId ?? sessionId,
      text: result?.text ?? "",
      model: result?.model ?? options.model ?? null,
      usage: result?.usage ?? null,
      toolCalls: result?.toolCalls ?? [],
      fileChanges: result?.fileChanges ?? [],
      error: null
    };
  } catch (error) {
    return {
      sessionId: null,
      text: "",
      model: null,
      usage: null,
      toolCalls: [],
      fileChanges: [],
      error
    };
  } finally {
    await client.close();
  }
}

/**
 * Run a code review via ACP. Collects git context and sends a review prompt.
 *
 * @param {string} cwd
 * @param {{ scope?: string, base?: string, model?: string, env?: NodeJS.ProcessEnv, onNotification?: (n: any) => void }} [options]
 * @returns {Promise<{ text: string, sessionId: string | null, scope: string, summary: string, error: unknown }>}
 */
export async function runAcpReview(cwd, options = {}) {
  const { scope, context } = collectReviewContext(cwd, {
    scope: options.scope,
    base: options.base
  });

  if (!context.diff && scope === "working-tree" && context.untrackedContents?.length === 0) {
    return {
      text: "No changes detected in the working tree. Nothing to review.",
      sessionId: null,
      scope,
      summary: "No changes",
      error: null
    };
  }

  const reviewPrompt = buildReviewPrompt(scope, context);

  const result = await runAcpPrompt(cwd, reviewPrompt, {
    model: options.model,
    approvalMode: "plan", // Read-only for reviews.
    env: options.env,
    onNotification: options.onNotification
  });

  return {
    text: result.text,
    sessionId: result.sessionId,
    scope,
    summary: context.summary,
    error: result.error
  };
}

/**
 * Run an adversarial review via ACP with a structured output prompt.
 *
 * @param {string} cwd
 * @param {{ scope?: string, base?: string, model?: string, focus?: string, schemaPath?: string, env?: NodeJS.ProcessEnv, onNotification?: (n: any) => void }} [options]
 * @returns {Promise<{ text: string, parsed: any, sessionId: string | null, scope: string, error: unknown }>}
 */
export async function runAcpAdversarialReview(cwd, options = {}) {
  const { scope, context } = collectReviewContext(cwd, {
    scope: options.scope,
    base: options.base
  });

  const targetLabel = scope === "branch"
    ? `Branch comparison: ${context.summary?.split("\n")[0] ?? "HEAD vs base"}`
    : `Working tree: ${context.summary?.split("\n")[0] ?? "uncommitted changes"}`;

  const userFocus = options.focus || "General review — no specific focus area requested.";

  // Build the collection guidance based on context.
  let reviewCollectionGuidance = "";
  if (context.diff) {
    reviewCollectionGuidance += `\n<diff>\n${context.diff}\n</diff>\n`;
  }
  if (context.untrackedContents?.length > 0) {
    for (const file of context.untrackedContents) {
      if (file.content) {
        reviewCollectionGuidance += `\n<untracked_file path="${file.path}">\n${file.content}\n</untracked_file>\n`;
      }
    }
  }

  const prompt = loadPrompt("adversarial-review", {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: userFocus,
    REVIEW_COLLECTION_GUIDANCE: reviewCollectionGuidance
  });

  // Append schema instructions.
  let fullPrompt = prompt;
  if (options.schemaPath) {
    const schema = readJsonFile(options.schemaPath);
    if (schema) {
      fullPrompt += `\n\n<output_schema>\n${JSON.stringify(schema, null, 2)}\n</output_schema>\n`;
      fullPrompt += "\nReturn ONLY valid JSON matching the schema above. No other text.";
    }
  }

  const result = await runAcpPrompt(cwd, fullPrompt, {
    model: options.model,
    approvalMode: "plan", // Read-only for reviews.
    env: options.env,
    onNotification: options.onNotification
  });

  const parsed = parseStructuredOutput(result.text);

  return {
    text: result.text,
    parsed,
    sessionId: result.sessionId,
    scope,
    error: result.error
  };
}

/**
 * Interrupt an active ACP prompt.
 *
 * @param {string} cwd
 * @param {{ sessionId?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ attempted: boolean, interrupted: boolean }>}
 */
export async function interruptAcpPrompt(cwd, options = {}) {
  try {
    const client = await GeminiAcpClient.connect(cwd, {
      reuseExistingBroker: true,
      env: options.env
    });
    try {
      const result = await client.request("cancel", {
        sessionId: options.sessionId
      });
      return { attempted: true, interrupted: result?.cancelled ?? false };
    } finally {
      await client.close();
    }
  } catch {
    return { attempted: true, interrupted: false };
  }
}

/**
 * Find the latest task session that can be resumed.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ id: string, status: string } | null>}
 */
export async function findLatestTaskThread(cwd, options = {}) {
  // Check job state for the most recent completed task with a sessionId.
  const { listJobs } = await import("./state.mjs");
  const jobs = listJobs(cwd);
  const taskJobs = jobs
    .filter((j) => j.kind === "task" && j.threadId)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  if (taskJobs.length === 0) {
    return null;
  }

  return {
    id: taskJobs[0].threadId,
    status: taskJobs[0].status
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse structured JSON output from model response text.
 * Handles responses that may have markdown code fences around JSON.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseStructuredOutput(text) {
  if (!text) {
    return null;
  }

  // Try direct JSON parse.
  try {
    return JSON.parse(text.trim());
  } catch {
    // Fall through.
  }

  // Try extracting from markdown code fence.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // Fall through.
    }
  }

  // Try finding the first { ... } block.
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.slice(braceStart, braceEnd + 1));
    } catch {
      // Fall through.
    }
  }

  return null;
}

/**
 * Read an output schema file.
 *
 * @param {string} schemaPath
 * @returns {any}
 */
export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

/**
 * Build a review prompt from collected git context.
 *
 * @param {string} scope
 * @param {any} context
 * @returns {string}
 */
function buildReviewPrompt(scope, context) {
  const lines = [];
  lines.push("<role>");
  lines.push("You are Gemini performing a code review.");
  lines.push("Review the provided changes for correctness, security, performance, and maintainability.");
  lines.push("</role>");
  lines.push("");
  lines.push("<task>");
  lines.push(`Review the following ${scope === "branch" ? "branch" : "working tree"} changes.`);
  lines.push("Focus on material issues: bugs, security vulnerabilities, data loss risks, and correctness problems.");
  lines.push("Do not comment on style, naming, or formatting unless it creates a functional issue.");
  lines.push("</task>");
  lines.push("");

  if (context.summary) {
    lines.push("<context>");
    lines.push(context.summary);
    lines.push("</context>");
    lines.push("");
  }

  if (context.diff) {
    lines.push("<diff>");
    lines.push(context.diff);
    lines.push("</diff>");
    lines.push("");
  }

  if (context.commits) {
    lines.push("<commits>");
    lines.push(context.commits);
    lines.push("</commits>");
    lines.push("");
  }

  if (context.untrackedContents?.length > 0) {
    for (const file of context.untrackedContents) {
      if (file.content) {
        lines.push(`<untracked_file path="${file.path}">`);
        lines.push(file.content);
        lines.push("</untracked_file>");
        lines.push("");
      }
    }
  }

  lines.push("<grounding_rules>");
  lines.push("Every finding must be grounded in the provided diff or file contents.");
  lines.push("Do not speculate about code you cannot see.");
  lines.push("If a finding depends on an inference, state that explicitly.");
  lines.push("</grounding_rules>");

  return lines.join("\n");
}

/**
 * Build a persistent task thread name for tracking.
 *
 * @param {string} taskText
 * @returns {string}
 */
export function buildPersistentTaskThreadName(taskText) {
  const truncated = taskText.slice(0, 80).replace(/\n/g, " ").trim();
  return `gemini-task: ${truncated}`;
}

/**
 * Default prompt for continuing a previous task.
 */
export const DEFAULT_CONTINUE_PROMPT = "Continue where you left off. If the previous task is complete, summarize the outcome.";
