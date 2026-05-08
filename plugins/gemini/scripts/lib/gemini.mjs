/**
 * Core Gemini functions — availability checks, auth status, running prompts,
 * reviews, and tasks through ACP.
 *
 * This mirrors the Codex plugin's codex.mjs but uses Gemini's ACP protocol
 * (JSON-RPC 2.0 via `gemini --acp`) instead of Codex's app-server.
 */

// All ACP call sites in this module use the v2 transport layer. The legacy
// `GeminiAcpClient` (formerly at `./acp-client.mjs`) was removed; only its
// constants survive in `./broker-constants.mjs`.
import { createAcpClient } from "#lib/acp/client.mjs";
import { geminiBackend } from "#lib/backends/gemini.mjs";

import { sanitizeDiagnosticMessage } from "./acp-diagnostics.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./broker-constants.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { readJsonFile } from "./fs.mjs";
import { collectReviewContext } from "./git.mjs";
import { recordJobEvent } from "./job-observability.mjs";
import { getPluginInfo } from "./plugin-info.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { loadPrompt } from "./prompts.mjs";
import { resolveThinkingConfig } from "./thinking.mjs";

let thinkingWarned = false;

/**
 * Convert an ACP session/update notification into a job-observability event.
 * Returns null when the notification is not a session update.
 */
export function buildJobEventFromAcpNotification(notification) {
  const update = notification?.params?.update;
  if (!update) {
    return null;
  }
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = update.content?.text ?? "";
    // Privacy: do NOT record the raw model text on the event log. Only record
    // the chunk size so /gemini:status can show liveness ("model is
    // streaming") without leaking the model's prose through the event log.
    return { type: "model_text_chunk", chars: String(text).length };
  }
  if (kind === "agent_thought_chunk") {
    const text = update.content?.text ?? "";
    return { type: "model_thought_chunk", chars: String(text).length };
  }
  if (kind === "tool_call") {
    return {
      type: "tool_call",
      toolName: sanitizeDiagnosticMessage(update.toolName ?? update.name ?? "unknown")
    };
  }
  if (kind === "file_change") {
    return {
      type: "file_change",
      path: sanitizeDiagnosticMessage(update.path ?? ""),
      action: sanitizeDiagnosticMessage(update.action ?? "modify")
    };
  }
  return {
    type: "acp_notification",
    message: sanitizeDiagnosticMessage(kind ?? "")
  };
}

/**
 * Shape a broker diagnostic payload as a classification-ready job event.
 */
export function formatBrokerDiagnostic({ source, message }) {
  return {
    type: "diagnostic",
    source: sanitizeDiagnosticMessage(source ?? "broker"),
    message: sanitizeDiagnosticMessage(message)
  };
}

function recordObserverEvent(observer, event) {
  if (!observer?.workspaceRoot || !observer?.jobId || !event) {
    return;
  }
  // Best-effort telemetry — never let observability failures (sync or async)
  // crash the ACP flow. `recordJobEvent` is async; attach a `.catch` and
  // drop any rejection so this helper remains fire-and-forget.
  try {
    Promise.resolve(recordJobEvent(observer.workspaceRoot, observer.jobId, event)).catch(() => {});
  } catch {
    // Swallow synchronous throws (e.g. bad args) for the same reason.
  }
}

function emitStreamEvent(onStream, event) {
  if (!onStream) return;
  try {
    onStream(event);
  } catch {
    // Best-effort live output must not interrupt ACP handling.
  }
}

function buildThoughtStreamEvent(text, includeText) {
  const normalized = String(text ?? "");
  const event = { type: "thought_chunk", chars: normalized.length };
  if (includeText) {
    event.text = normalized;
  }
  return event;
}

function buildToolStreamEvent(update) {
  return {
    type: "tool_call",
    toolName: sanitizeDiagnosticMessage(update.toolName ?? update.name ?? "unknown") || "unknown"
  };
}

function buildFileStreamEvent(update) {
  return {
    type: "file_change",
    path: sanitizeDiagnosticMessage(update.path ?? ""),
    action: sanitizeDiagnosticMessage(update.action ?? "modify") || "modify"
  };
}

function emitThinkingWarningIfNew(writer = (s) => process.stderr.write(s)) {
  if (thinkingWarned) {
    return;
  }
  writer(
    "Warning: --thinking is parsed but not delivered to the running Gemini CLI. " +
      "Configure thinkingConfig at the model-alias level in your Gemini settings.json " +
      "for a persistent setting. See " +
      "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/generation-settings.md\n"
  );
  thinkingWarned = true;
}

function resetThinkingWarning() {
  thinkingWarned = false;
}

/**
 * Escape content embedded in XML-style prompt tags so that user-controlled
 * text (diffs, file contents) cannot close the containing tag and break
 * the prompt structure.
 *
 * @param {string} content
 * @param {string} tagName — the enclosing tag name to protect
 * @returns {string}
 */
function escapeXmlContent(content, tagName) {
  if (!content) return content;
  // Escape any closing tag that matches the container (case-insensitive).
  const pattern = new RegExp(`</${tagName}`, "gi");
  return content.replace(pattern, `<\\/${tagName}`);
}

/**
 * @typedef {{
 *   onProgress?: (message: string) => void
 * }} ProgressReporter
 */

/**
 * @typedef {{
 *   sessionId: string | null,
 *   text: string,
 *   chunkCount: number,
 *   chunkChars: number,
 *   thoughtText: string,
 *   thoughtCount: number,
 *   thoughtChars: number,
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
 * CI runs against an ACP-mock `gemini` binary (see `tests/mocks/gemini-mock.mjs`,
 * inspired by Zed Industries' ACP testbench pattern: a real executable that
 * speaks the JSON-RPC handshake with canned responses). The mock advertises
 * `oauth-personal` and answers `authenticate` immediately, so this code path
 * does not need a separate timeout escape hatch — the mock returns in
 * milliseconds and the real binary is interactive only when explicitly invoked
 * by the user. Tests for this function should drive it via the mock, not
 * stub `process.env` flags.
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

  // v2 path: spawn `gemini --acp` via the new transport layer, perform a
  // manual handshake to recover capabilities (the new createAcpClient does
  // not auto-handshake — that's intentional, since not every consumer wants
  // the initialize round-trip), then walk the auth-method priority order.
  // disableBroker semantics are inherent: transports.cli always spawns a
  // fresh subprocess, never touching the broker socket.
  const transport = geminiBackend.transports.cli({
    cwd,
    env: process.env
  });
  const client = createAcpClient(transport);
  try {
    await client.start();
    const info = getPluginInfo();
    /** @type {any} */
    const init = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: info.name, version: info.version }
    });
    const authMethods = init?.authMethods ?? [];
    // Priority order: oauth-personal first (most common for interactive
    // users), then fall back to any other advertised method.
    const methodOrder = [
      "oauth-personal",
      "gemini-api-key",
      "vertex-ai",
      "cloud-shell",
      "compute-default-credentials",
      "gateway"
    ];
    const available = methodOrder.filter((m) =>
      authMethods.some(/** @param {{ id: string }} am */ (am) => am.id === m)
    );

    for (const methodId of available) {
      try {
        /** @type {any} */
        const result = await client.request("authenticate", { methodId });
        // A successful (non-error) response that doesn't explicitly say
        // authenticated:false means the user is already authenticated.
        if (result && result.authenticated !== false) {
          return { authenticated: true, method: methodId };
        }
      } catch {}
    }

    return { authenticated: false, method: null };
  } catch {
    return { authenticated: false, method: null };
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

/**
 * Connect to the Gemini ACP runtime via the v2 transport layer with the
 * legacy broker-fallback semantics: try broker (existing or freshly spawned)
 * first, fall back to a direct CLI subprocess on broker-busy or any other
 * broker connection failure.
 *
 * Returns the started AcpSession plus the initialize-result capabilities so
 * callers can inspect e.g. `authMethods` without re-issuing the request.
 *
 * `onDiagnostic` mirrors the legacy hook: when broker fallback fires, the
 * fallback message is forwarded to the caller for job-event recording.
 *
 * `launchOptions` are forwarded to `geminiBackend.transports.cli` when the
 * broker path isn't taken (the broker is already running, so it can't honor
 * fresh launch flags). Per the v2 architecture, these become CLI argv via
 * `buildGeminiArgs` — see `lib/backends/gemini.mjs`.
 *
 * @param {string} cwd
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   reuseExistingBroker?: boolean,
 *   disableBroker?: boolean,
 *   onDiagnostic?: (payload: { source: string, message: string }) => void,
 *   launchOptions?: import("#lib/backends/gemini.mjs").BackendConfig
 * }} [options]
 * @returns {Promise<{ client: import("#lib/acp/types.mjs").AcpSession, capabilities: any, viaBroker: boolean }>}
 */
async function connectGeminiAcpV2(cwd, options = {}) {
  let brokerEndpoint = null;
  if (!options.disableBroker) {
    brokerEndpoint = options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
    if (!brokerEndpoint && options.reuseExistingBroker) {
      brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
    }
    if (!brokerEndpoint && !options.reuseExistingBroker) {
      const brokerSession = await ensureBrokerSession(cwd, {
        env: options.env
      });
      brokerEndpoint = brokerSession?.endpoint ?? null;
    }
  }

  const info = getPluginInfo();
  /** @type {import("#lib/acp/types.mjs").AcpSession | null} */
  let client = null;
  let capabilities = null;

  if (brokerEndpoint) {
    const transport = geminiBackend.transports.brokerSocket(brokerEndpoint, {
      cwd,
      env: options.env
    });
    const candidate = createAcpClient(transport);
    try {
      await candidate.start();
      capabilities = await candidate.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: info.name, version: info.version }
      });
      client = candidate;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      const fallbackMessage =
        code === BROKER_BUSY_RPC_CODE
          ? "Broker busy, falling back to direct gemini --acp spawn."
          : `Broker connection failed (${/** @type {any} */ (error)?.message ?? error}), falling back to direct spawn.`;
      process.stderr.write(`${fallbackMessage}\n`);
      try {
        options.onDiagnostic?.({
          source: "broker-fallback",
          message: sanitizeDiagnosticMessage(fallbackMessage)
        });
      } catch {
        // Best-effort.
      }
      try {
        await candidate.close();
      } catch {
        // Already failed; nothing more to clean up.
      }
    }
  }

  const viaBroker = client !== null;

  if (!client) {
    // launchOptions are CLI-flag-shaped (yolo, approvalMode, worktree,
    // policyFiles, etc.) and only meaningful on a fresh subprocess. The
    // broker path can't honor them — the broker's child was started long
    // before this call. If the caller passed launch options AND we ended
    // up on the broker path, those options are silently inert; that's
    // intentional (see docs/architecture.md "Key invariants" — broker
    // reuse trades fresh launch flags for amortized startup cost).
    // launchOptions FIRST so outer cwd/env always win — callers shouldn't
    // accidentally relocate the spawn by stuffing cwd into launchOptions.
    const transport = geminiBackend.transports.cli({
      ...(options.launchOptions ?? {}),
      cwd,
      env: options.env
    });
    client = createAcpClient(transport);
    await client.start();
    capabilities = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: info.name, version: info.version }
    });
  }

  return { client, capabilities, viaBroker };
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
  const endpoint =
    session?.endpoint ?? env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
  return {
    brokerRunning: Boolean(session),
    endpoint
  };
}

// ─── ACP Operations ───────────────────────────────────────────────────────────

function createNotificationSinks() {
  return {
    textChunks: [],
    chunkCount: 0,
    chunkChars: 0,
    thoughtCount: 0,
    thoughtChars: 0,
    toolCalls: [],
    fileChanges: [],
    events: []
  };
}

function dispatchOneNotification(notification, sinks, onStream, options = {}) {
  const update = notification?.params?.update;
  if (!update) return;
  const streamThoughtText = options.streamThoughtText === true;

  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    const text = String(update.content.text ?? "");
    sinks.textChunks.push(text);
    sinks.chunkCount += 1;
    sinks.chunkChars += text.length;
    const ev = { type: "message_chunk", text };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
    const text = String(update.content.text ?? "");
    sinks.thoughtCount += 1;
    sinks.thoughtChars += text.length;
    const ev = buildThoughtStreamEvent(text, streamThoughtText);
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "tool_call") {
    sinks.toolCalls.push({
      name: update.toolName ?? update.name ?? "unknown",
      arguments: update.arguments ?? update.input ?? {},
      result: update.result ?? undefined
    });
    const ev = buildToolStreamEvent(update);
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "file_change") {
    sinks.fileChanges.push({
      path: update.path ?? "",
      action: update.action ?? "modify"
    });
    const ev = buildFileStreamEvent(update);
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  }
}

/**
 * Pure dispatch over a sequence of session/update notifications.
 * Exposed for tests; mirrors the real runAcpPrompt loop body.
 */
function dispatchNotifications(notifications, onStream, options = {}) {
  const sinks = createNotificationSinks();

  for (const notification of notifications) {
    dispatchOneNotification(notification, sinks, onStream, options);
  }

  return {
    text: sinks.textChunks.join(""),
    chunkCount: sinks.chunkCount,
    chunkChars: sinks.chunkChars,
    thoughtText: "",
    thoughtCount: sinks.thoughtCount,
    thoughtChars: sinks.thoughtChars,
    toolCalls: sinks.toolCalls,
    fileChanges: sinks.fileChanges,
    events: sinks.events
  };
}

export const __testing = {
  simulateNotificationDispatch(notifications, onStream, options) {
    return dispatchNotifications(notifications, onStream, options);
  },
  emitThinkingWarningIfNew,
  resetThinkingWarning
};

/**
 * Run a prompt through Gemini ACP and capture the result.
 *
 * @param {string} cwd
 * @param {string} prompt
 * @param {{
 *   model?: string,
 *   thinkingBudget?: number,
 *   thinking?: "off"|"low"|"medium"|"high",
 *   approvalMode?: string,
 *   sessionId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   onNotification?: (n: any) => void,
 *   onStream?: (event: any) => void,
 *   streamThoughtText?: boolean,
 *   jobObserver?: any,
 *   onDiagnostic?: (payload: { source: string, message: string }) => void,
 *   launchOptions?: import("#lib/backends/gemini.mjs").BackendConfig,
 *   disableBroker?: boolean
 * }} [options]
 * @returns {Promise<TurnResult>}
 */
export async function runAcpPrompt(cwd, prompt, options = {}) {
  // Collect streamed text and tool calls from session/update notifications.
  const sinks = createNotificationSinks();
  const observer =
    options.jobObserver?.workspaceRoot && options.jobObserver.jobId ? options.jobObserver : null;

  const notificationHandler = (notification) => {
    dispatchOneNotification(notification, sinks, options.onStream, {
      streamThoughtText: options.streamThoughtText === true
    });

    recordObserverEvent(observer, buildJobEventFromAcpNotification(notification));

    // Forward to caller's handler if provided.
    if (options.onNotification) {
      options.onNotification(notification);
    }
  };

  const diagnosticHandler = (payload) => {
    recordObserverEvent(observer, formatBrokerDiagnostic(payload));
    if (options.onDiagnostic) {
      try {
        options.onDiagnostic(payload);
      } catch {
        // Best-effort.
      }
    }
  };

  // v2 transport path: connect via the new layer with broker fallback,
  // then attach the notification handler. The legacy `connect()` accepted
  // the handler at construction time; the v2 client exposes
  // `onNotification(handler)` for the same purpose. Order matters — we
  // attach BEFORE issuing any session/* requests so we don't miss the
  // first session/update notification.
  const { client } = await connectGeminiAcpV2(cwd, {
    env: options.env,
    onDiagnostic: diagnosticHandler,
    launchOptions: options.launchOptions,
    disableBroker: options.disableBroker
  });
  client.onNotification(notificationHandler);

  try {
    // Create or load session.
    let sessionId = options.sessionId ?? null;
    if (sessionId) {
      await client.request("session/load", { sessionId, cwd, mcpServers: [] });
      recordObserverEvent(observer, {
        type: "phase",
        message: "session_loaded"
      });
      emitStreamEvent(options.onStream, {
        type: "phase",
        message: "session_loaded"
      });
    } else {
      const session = await client.request("session/new", {
        cwd,
        mcpServers: []
      });
      sessionId = session?.sessionId ?? null;
      recordObserverEvent(observer, {
        type: "phase",
        message: "session_created"
      });
      emitStreamEvent(options.onStream, {
        type: "phase",
        message: "session_created"
      });
    }

    // Set approval mode (defaults to autoEdit if not specified).
    {
      const modeMap = {
        auto_edit: "autoEdit",
        default: "default",
        yolo: "yolo",
        plan: "plan"
      };
      const modeId = modeMap[options.approvalMode ?? "auto_edit"] ?? options.approvalMode;
      try {
        await client.request("session/set_mode", { sessionId, modeId });
      } catch (error) {
        process.stderr.write(
          `Warning: could not set mode to ${modeId}: ${error?.message ?? error}\n`
        );
      }
    }

    // Set model if requested.
    if (options.model) {
      try {
        await client.request("session/set_model", {
          sessionId,
          modelId: options.model
        });
      } catch (error) {
        process.stderr.write(
          `Warning: could not set model to ${options.model}: ${error?.message ?? error}\n`
        );
      }
    }

    let resolvedThinking = null;
    if (options.thinking !== undefined) {
      resolvedThinking = resolveThinkingConfig(options.thinking, options.model ?? null);
      for (const note of resolvedThinking.notes) {
        process.stderr.write(`Thinking: ${note}\n`);
      }
      recordObserverEvent(observer, {
        type: "phase",
        message: `thinking:${options.thinking}`
      });
      emitStreamEvent(options.onStream, {
        type: "phase",
        message: sanitizeDiagnosticMessage(`thinking:${options.thinking}`)
      });
      // Delivery: upstream Gemini CLI (0.38.x) does not accept a per-invocation
      // thinking override via CLI flag, env var, or session/new param; the
      // configuration lives in settings.json at the model-alias level.
      emitThinkingWarningIfNew();
    }

    // Send prompt — ACP v1 expects prompt as ContentBlock[].
    // Text is streamed via session/update notifications; the response only has metadata.
    const result = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }]
    });

    const text = sinks.textChunks.join("");
    const usage = result?._meta?.quota?.token_count ?? null;

    return {
      sessionId,
      text,
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      thoughtText: "",
      thoughtCount: sinks.thoughtCount,
      thoughtChars: sinks.thoughtChars,
      model: result?._meta?.quota?.model_usage?.[0]?.model ?? options.model ?? null,
      usage,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
      error: null
    };
  } catch (error) {
    return {
      sessionId: null,
      text: sinks.textChunks.join(""),
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      thoughtText: "",
      thoughtCount: sinks.thoughtCount,
      thoughtChars: sinks.thoughtChars,
      model: null,
      usage: null,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
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
 * @param {{
 *   scope?: string,
 *   base?: string,
 *   model?: string,
 *   thinking?: "off"|"low"|"medium"|"high",
 *   env?: NodeJS.ProcessEnv,
 *   onNotification?: (n: any) => void,
 *   onStream?: (event: any) => void,
 *   streamThoughtText?: boolean,
 *   jobObserver?: any,
 *   onDiagnostic?: (payload: { source: string, message: string }) => void,
 *   launchOptions?: import("#lib/backends/gemini.mjs").BackendConfig,
 *   disableBroker?: boolean
 * }} [options]
 * @returns {Promise<{ text: string, sessionId: string | null, scope: string, summary: string, fileChanges: Array<{ path: string, action: string }>, toolCalls: Array<{ name: string, arguments: Record<string, unknown>, result?: string }>, error: unknown }>}
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
      fileChanges: [],
      toolCalls: [],
      error: null
    };
  }

  const reviewPrompt = buildReviewPrompt(scope, context);

  const result = await runAcpPrompt(cwd, reviewPrompt, {
    model: options.model,
    thinking: options.thinking,
    onStream: options.onStream,
    streamThoughtText: options.streamThoughtText,
    approvalMode: "plan", // Read-only for reviews.
    env: options.env,
    onNotification: options.onNotification,
    jobObserver: options.jobObserver,
    onDiagnostic: options.onDiagnostic,
    launchOptions: options.launchOptions,
    disableBroker: options.disableBroker
  });

  return {
    text: result.text,
    sessionId: result.sessionId,
    scope,
    summary: context.summary,
    fileChanges: result.fileChanges,
    toolCalls: result.toolCalls,
    error: result.error
  };
}

/**
 * Run an adversarial review via ACP with a structured output prompt.
 *
 * @param {string} cwd
 * @param {{
 *   scope?: string,
 *   base?: string,
 *   model?: string,
 *   thinking?: "off"|"low"|"medium"|"high",
 *   focus?: string,
 *   schemaPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   onNotification?: (n: any) => void,
 *   onStream?: (event: any) => void,
 *   streamThoughtText?: boolean,
 *   jobObserver?: any,
 *   onDiagnostic?: (payload: { source: string, message: string }) => void,
 *   launchOptions?: import("#lib/backends/gemini.mjs").BackendConfig,
 *   disableBroker?: boolean
 * }} [options]
 * @returns {Promise<{ text: string, parsed: any, sessionId: string | null, scope: string, fileChanges: Array<{ path: string, action: string }>, toolCalls: Array<{ name: string, arguments: Record<string, unknown>, result?: string }>, error: unknown }>}
 */
export async function runAcpAdversarialReview(cwd, options = {}) {
  const { scope, context } = collectReviewContext(cwd, {
    scope: options.scope,
    base: options.base
  });

  const targetLabel =
    scope === "branch"
      ? `Branch comparison: ${context.summary?.split("\n")[0] ?? "HEAD vs base"}`
      : `Working tree: ${context.summary?.split("\n")[0] ?? "uncommitted changes"}`;

  const userFocus = options.focus || "General review — no specific focus area requested.";

  // Build the collection guidance based on context.
  let reviewCollectionGuidance = "";
  if (context.diff) {
    reviewCollectionGuidance += `\n<diff>\n${escapeXmlContent(context.diff, "diff")}\n</diff>\n`;
  }
  if (context.untrackedContents?.length > 0) {
    for (const file of context.untrackedContents) {
      if (file.content) {
        reviewCollectionGuidance += `\n<untracked_file path="${file.path}">\n${escapeXmlContent(file.content, "untracked_file")}\n</untracked_file>\n`;
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
    thinking: options.thinking,
    onStream: options.onStream,
    streamThoughtText: options.streamThoughtText,
    approvalMode: "plan", // Read-only for reviews.
    env: options.env,
    onNotification: options.onNotification,
    jobObserver: options.jobObserver,
    onDiagnostic: options.onDiagnostic,
    launchOptions: options.launchOptions,
    disableBroker: options.disableBroker
  });

  const parsed = parseStructuredOutput(result.text);

  return {
    text: result.text,
    parsed,
    sessionId: result.sessionId,
    scope,
    fileChanges: result.fileChanges,
    toolCalls: result.toolCalls,
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
  // T7 (add-transport-abstraction-with-gemini) — this call site uses the v2
  // transport layer (`lib/backends/gemini.mjs::transports.brokerSocket` wired
  // through `lib/acp/client.mjs::createAcpClient`). When a broker session
  // exists, route through it; when one does not, fall back to a one-shot
  // direct CLI subprocess via `transports.cli`. The direct fallback won't
  // reach an in-flight session in another process — but neither did the
  // legacy code path; behavior parity is preserved.
  const session = loadBrokerSession(cwd);
  /** @type {import("#lib/acp/client.mjs").ClientTransport} */
  const transport = session?.endpoint
    ? geminiBackend.transports.brokerSocket(session.endpoint, {
        cwd,
        env: options.env
      })
    : geminiBackend.transports.cli({ cwd, env: options.env });
  const client = createAcpClient(transport);
  try {
    await client.start();
    client.notify("session/cancel", {
      sessionId: options.sessionId
    });
    return { attempted: true, interrupted: true };
  } catch {
    return { attempted: true, interrupted: false };
  } finally {
    try {
      await client.close();
    } catch {
      // Already torn down.
    }
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
  lines.push(
    "Review the provided changes for correctness, security, performance, and maintainability."
  );
  lines.push("</role>");
  lines.push("");
  lines.push("<task>");
  lines.push(`Review the following ${scope === "branch" ? "branch" : "working tree"} changes.`);
  lines.push(
    "Focus on material issues: bugs, security vulnerabilities, data loss risks, and correctness problems."
  );
  lines.push(
    "Do not comment on style, naming, or formatting unless it creates a functional issue."
  );
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
    lines.push(escapeXmlContent(context.diff, "diff"));
    lines.push("</diff>");
    lines.push("");
  }

  if (context.commits) {
    lines.push("<commits>");
    lines.push(escapeXmlContent(context.commits, "commits"));
    lines.push("</commits>");
    lines.push("");
  }

  if (context.untrackedContents?.length > 0) {
    for (const file of context.untrackedContents) {
      if (file.content) {
        lines.push(`<untracked_file path="${file.path}">`);
        lines.push(escapeXmlContent(file.content, "untracked_file"));
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
export const DEFAULT_CONTINUE_PROMPT =
  "Continue where you left off. If the previous task is complete, summarize the outcome.";
