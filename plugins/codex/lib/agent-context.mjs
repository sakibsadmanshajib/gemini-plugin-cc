/**
 * AgentContext — the single carrier for per-turn / per-session
 * configuration that flows through the runtime.
 *
 * Goals (from the v2 plan):
 *
 *   - Lib code reads from `context.<field>` instead of `process.env`.
 *   - Env vars are consulted ONCE at the boundary (this module) to
 *     build a context for back-compat with legacy callers.
 *   - Illegal states (e.g. streaming both on and off) are
 *     unrepresentable: tri-state enums replace boolean mutex pairs.
 *   - The returned context is **deep-frozen** so a leaked reference
 *     can't mutate dispatch/logging/cost/facade policy between turns.
 *     (Note: `context.env` is the host's `NodeJS.ProcessEnv` and is
 *     intentionally NOT deep-frozen — it is preserved as-is for
 *     `child_process.spawn` inheritance.)
 *
 * What's NOT in the context:
 *
 *   - `signal: AbortSignal` — per-call lifetime, lives on per-turn
 *     options, not per-session config.
 *   - Per-call observation hooks (`onUpdate`) — same reason.
 *
 * See `./cli/flags.mjs` for the CLI parser this module consumes.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseRunnerArgs } from "./cli/flags.mjs";

/**
 * @typedef {"on" | "off" | "default"} TriState
 *
 * @typedef {Readonly<{
 *   streaming: TriState,
 *   facade:    TriState,
 *   broker:    "auto" | "disabled"
 * }>} DispatchPolicy
 *
 * @typedef {Readonly<{
 *   wireLogPath?: string,
 *   wireLogRaw?:  boolean,
 *   traceId?:     string
 * }>} LoggingPolicy
 *
 * @typedef {Readonly<{
 *   logPath?:         string,
 *   disabled?:        boolean,
 *   pricingOverride?: string
 * }>} CostPolicy
 *
 * @typedef {Readonly<{
 *   apiKey?: string,
 *   cors?:   string
 * }>} FacadePolicy
 *
 * Per-turn session intent for streaming runners. Tagged union — exactly
 * one of three actions:
 *   - `{ action: "reuse" }`           → runner uses the session it
 *                                        created at start()
 *   - `{ action: "fresh" }`           → runner calls session/new (or
 *                                        thread/start), replaces stored
 *                                        id, then runs the prompt
 *   - `{ action: "resume", id: "x" }` → runner calls session/load (or
 *                                        thread/resume), replaces stored
 *                                        id, then runs the prompt
 *
 * Illegal states (fresh + id together) are unrepresentable at the type
 * level — no runtime mutex check needed. Cold-start runners and the
 * facade ignore this policy; F2's boundary guard throws when an action
 * other than "reuse" is set on a non-streaming dispatch path.
 *
 * @typedef {Readonly<{ action: "reuse" }>
 *         | Readonly<{ action: "fresh" }>
 *         | Readonly<{ action: "resume", id: string }>} SessionPolicy
 *
 * @typedef {Readonly<{
 *   schemaVersion: 1,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   dispatch: DispatchPolicy,
 *   logging:  LoggingPolicy,
 *   cost:     CostPolicy,
 *   facade:   FacadePolicy,
 *   session:  SessionPolicy,
 *   model?:   string,
 *   timeoutMs?: number,
 *   debug?:   boolean
 * }>} AgentContext
 */

/**
 * Env-var keys this project owns (i.e. ones the boundary may read).
 * Anything matching `ARTAGON_*` or `ACP_WIRE_LOG*` that is NOT in this
 * set will trigger a "did you mean" warning (or a throw under
 * `--strict-env`). External contracts (ANTHROPIC_API_KEY, XDG_*,
 * CLAUDE_PLUGIN_*, …) are NOT internal config and are not validated
 * here — they pass through `context.env` to spawned subprocesses.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_INTERNAL_ENV_KEYS = new Set([
  "ARTAGON_STREAMING",
  "ARTAGON_DISABLE_BROKER",
  "ARTAGON_USE_FACADE",
  "ARTAGON_COST_LOG",
  "ARTAGON_PRICING_OVERRIDE",
  "ARTAGON_FACADE_API_KEY",
  "ARTAGON_FACADE_CORS",
  "ARTAGON_STRICT_ENV",
  "ARTAGON_ACP_BACKEND",
  "ARTAGON_ACP_IDLE_MS",
  "ACP_WIRE_LOG",
  "ACP_WIRE_LOG_RAW"
]);

/** Default policy when nothing else is specified. */
const DEFAULT_DISPATCH = Object.freeze({
  streaming: /** @type {TriState} */ ("default"),
  facade: /** @type {TriState} */ ("default"),
  broker: /** @type {"auto" | "disabled"} */ ("auto")
});
const DEFAULT_LOGGING = Object.freeze({});
const DEFAULT_COST = Object.freeze({});
const DEFAULT_FACADE = Object.freeze({});
/** @type {SessionPolicy} */
const DEFAULT_SESSION = Object.freeze({ action: "reuse" });

/**
 * Construct an `AgentContext`. Partial fields are filled with safe
 * defaults; sub-policies are deep-frozen; the outer object is frozen.
 * Throws on invariant violations the type system can't express:
 *
 *   - `dispatch.facade === "on"` AND `facade.apiKey` missing
 *   - `cost.disabled === true` AND `cost.logPath` set
 *   - `timeoutMs` set to a non-finite or non-positive number
 *
 * @param {object} [partial]
 * @param {string} [partial.cwd]
 * @param {NodeJS.ProcessEnv} [partial.env]
 * @param {Partial<DispatchPolicy>} [partial.dispatch]
 * @param {Partial<LoggingPolicy>}  [partial.logging]
 * @param {Partial<CostPolicy>}     [partial.cost]
 * @param {Partial<FacadePolicy>}   [partial.facade]
 * @param {Partial<SessionPolicy>}  [partial.session]
 * @param {string}  [partial.model]
 * @param {number}  [partial.timeoutMs]
 * @param {boolean} [partial.debug]
 * @returns {AgentContext}
 */
export function createAgentContext(partial = {}) {
  const dispatch = Object.freeze({
    ...DEFAULT_DISPATCH,
    ...(partial.dispatch ?? {})
  });
  const logging = Object.freeze({
    ...DEFAULT_LOGGING,
    ...(partial.logging ?? {})
  });
  const cost = Object.freeze({
    ...DEFAULT_COST,
    ...(partial.cost ?? {})
  });
  const facade = Object.freeze({
    ...DEFAULT_FACADE,
    ...(partial.facade ?? {})
  });
  // Session policy is a tagged union. TypeScript rejects the illegal
  // {action: "fresh", id: "x"} combo at compile time, but JS-only and
  // HTTP callers can still construct one — and the runner's switch
  // would silently drop the `id`. Reject loudly at the factory.
  const session = /** @type {SessionPolicy} */ (Object.freeze(partial.session ?? DEFAULT_SESSION));
  const sessionAny = /** @type {any} */ (session);
  if (session.action === "resume") {
    if (typeof session.id !== "string" || session.id.length === 0) {
      throw new Error('AgentContext: session.action="resume" requires a non-empty string id');
    }
  } else if (session.action === "reuse" || session.action === "fresh") {
    if (sessionAny.id !== undefined) {
      throw new Error(
        `AgentContext: session.action="${session.action}" must not carry an id ` +
          `(got id=${JSON.stringify(sessionAny.id)}). ` +
          'Use {action:"resume", id:"<sid>"} to resume.'
      );
    }
  } else {
    throw new Error(
      `AgentContext: session.action must be one of "reuse" | "fresh" | "resume" ` +
        `(got ${JSON.stringify(sessionAny.action)})`
    );
  }
  if (dispatch.facade === "on" && !facade.apiKey) {
    throw new Error(
      'AgentContext: dispatch.facade is "on" but facade.apiKey is unset. ' +
        "Pass --facade-key <token> or set ARTAGON_FACADE_API_KEY."
    );
  }
  if (cost.disabled === true && cost.logPath !== undefined) {
    throw new Error(
      "AgentContext: cost.disabled is true and cost.logPath is set — these are mutually exclusive."
    );
  }
  if (partial.timeoutMs !== undefined) {
    if (!Number.isFinite(partial.timeoutMs) || partial.timeoutMs <= 0) {
      throw new Error(
        `AgentContext: timeoutMs must be a finite positive number; got ${partial.timeoutMs}`
      );
    }
  }
  if (
    partial.model !== undefined &&
    (typeof partial.model !== "string" || partial.model.length === 0)
  ) {
    throw new Error("AgentContext: model must be a non-empty string when set");
  }

  /** @type {AgentContext} */
  const ctx = /** @type {any} */ (
    Object.freeze({
      schemaVersion: 1,
      cwd: partial.cwd ?? process.cwd(),
      env: partial.env ?? process.env,
      dispatch,
      logging,
      cost,
      facade,
      session,
      ...(partial.model !== undefined && { model: partial.model }),
      ...(partial.timeoutMs !== undefined && { timeoutMs: partial.timeoutMs }),
      ...(partial.debug !== undefined && { debug: partial.debug })
    })
  );
  return ctx;
}

/**
 * Derive a new context with the given overrides applied. The original
 * is untouched.
 *
 * **Merge semantics:**
 *   - `dispatch`, `logging`, `cost`, `facade` are **shallow-merged**:
 *     unmentioned fields preserve the base context's values. Example:
 *     `withOverrides(ctx, { dispatch: { streaming: "on" }})` keeps the
 *     existing `dispatch.facade` and `dispatch.broker`.
 *   - `session` is **wholesale-replaced**, not merged. SessionPolicy's
 *     `id` and `fresh` are mutex; shallow-merging risks producing
 *     `{ fresh: true, id: "x" }` which would then fail the factory's
 *     mutex check. Replacement matches the intent: a per-turn override
 *     of session policy supersedes the parent's policy entirely.
 *     `overrides.session === undefined` falls through to base (no change).
 *     `overrides.session === {}` clears any inherited policy (explicit
 *     "reuse").
 *   - `model`, `timeoutMs`, `debug` use `??` so falsy values pass
 *     through unchanged.
 *
 * @param {AgentContext} ctx
 * @param {object} overrides
 * @returns {AgentContext}
 */
export function withOverrides(ctx, overrides = {}) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("withOverrides: ctx must be an AgentContext");
  }
  return createAgentContext({
    cwd: overrides.cwd ?? ctx.cwd,
    env: overrides.env ?? ctx.env,
    dispatch: { ...ctx.dispatch, ...(overrides.dispatch ?? {}) },
    logging: { ...ctx.logging, ...(overrides.logging ?? {}) },
    cost: { ...ctx.cost, ...(overrides.cost ?? {}) },
    facade: { ...ctx.facade, ...(overrides.facade ?? {}) },
    session: overrides.session ?? ctx.session,
    model: overrides.model ?? ctx.model,
    timeoutMs: overrides.timeoutMs ?? ctx.timeoutMs,
    debug: overrides.debug ?? ctx.debug
  });
}

/**
 * Migration shim for the `AgentContext` schema. Today the only version
 * is `1`, so this is an identity for matching contexts and a loud
 * failure for anything else. Adding a real migration path here is the
 * supported escape hatch when the context shape evolves — callers that
 * load a serialized context from disk / cross-process can run it
 * through `migrateAgentContext` to either get a current-schema object
 * back or fail at the boundary with an actionable error, rather than
 * silently mis-reading fields that moved.
 *
 * Without this function, the `schemaVersion` field is unread ceremony.
 *
 * @param {{ schemaVersion?: number } & Record<string, any>} ctx
 * @returns {AgentContext}
 */
export function migrateAgentContext(ctx) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("migrateAgentContext: ctx must be an object");
  }
  if (ctx.schemaVersion === 1) {
    return /** @type {AgentContext} */ (ctx);
  }
  throw new Error(
    `migrateAgentContext: unsupported schemaVersion ${JSON.stringify(ctx.schemaVersion)}; expected 1`
  );
}

/**
 * Boundary builder: parse argv into flags, layer env-var fallback,
 * audit env for typos / mixed-source disagreement, and construct the
 * frozen context. This is the **one place** in the project where the
 * internal env-var keys are read.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ context: AgentContext, prompt: string, rest: string[], helpRequested: boolean }}
 */
export function buildAgentContextFromArgv(argv, env = process.env, opts = {}) {
  const parsed = parseRunnerArgs(argv);
  if (parsed.helpRequested) {
    return {
      context: createAgentContext({ env }),
      prompt: parsed.prompt,
      rest: parsed.rest,
      helpRequested: true
    };
  }

  // `--strict-env` flag or `ARTAGON_STRICT_ENV=1` env var.
  const strict =
    opts.strict === true || parsed.flags.strictEnv === true || env.ARTAGON_STRICT_ENV === "1";

  auditEnvKeys(env, { strict });

  // Layer env-var fallback per field, throwing on mixed-source
  // disagreement so silent overrides don't change behavior.
  const dispatch = resolveDispatch(parsed.flags, env);
  const logging = resolveLogging(parsed.flags, env);
  const cost = resolveCost(parsed.flags, env);
  const facade = resolveFacade(parsed.flags, env);
  const session = resolveSession(parsed.flags);

  const context = createAgentContext({
    cwd: parsed.flags.cwd ?? process.cwd(),
    env,
    dispatch,
    logging,
    cost,
    facade,
    session,
    model: parsed.flags.model,
    timeoutMs: parsed.flags.timeoutMs,
    debug: (parsed.flags.debug ?? env.DEBUG === "1") ? true : undefined
  });

  return {
    context,
    prompt: parsed.prompt,
    rest: parsed.rest,
    helpRequested: false
  };
}

/**
 * @param {import("./cli/flags.mjs").ParsedFlags} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {Partial<DispatchPolicy>}
 */
function resolveDispatch(flags, env) {
  /** @type {{ streaming?: TriState, facade?: TriState, broker?: "auto" | "disabled" }} */
  const out = {};

  // streaming: tri-state
  const flagStreaming = flags.streaming;
  const envStreaming = triFromEnvBool(env.ARTAGON_STREAMING);
  out.streaming = mergeTri("--streaming", flagStreaming, "ARTAGON_STREAMING", envStreaming);

  // facade: tri-state
  const flagFacade = flags.facade;
  const envFacade = triFromEnvBool(env.ARTAGON_USE_FACADE);
  out.facade = mergeTri("--facade", flagFacade, "ARTAGON_USE_FACADE", envFacade);

  // broker: binary
  if (flags.broker === "disabled") {
    out.broker = "disabled";
    if (env.ARTAGON_DISABLE_BROKER === "0") {
      throw new Error(
        "Conflicting config: --no-broker set but ARTAGON_DISABLE_BROKER=0 in env. Unset one."
      );
    }
  } else if (env.ARTAGON_DISABLE_BROKER === "1") {
    out.broker = "disabled";
  } else {
    out.broker = "auto";
  }

  return out;
}

/**
 * @param {import("./cli/flags.mjs").ParsedFlags} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {LoggingPolicy}
 */
function resolveLogging(flags, env) {
  /** @type {{ wireLogPath?: string, wireLogRaw?: boolean, traceId?: string }} */
  const out = {};
  const wireLog = flags.wireLog ?? env.ACP_WIRE_LOG;
  if (wireLog !== undefined && wireLog.length > 0) {
    validateWritableDir(wireLog, "--wire-log/ACP_WIRE_LOG");
    out.wireLogPath = wireLog;
  }
  if (flags.wireLogRaw === true || env.ACP_WIRE_LOG_RAW === "1") {
    out.wireLogRaw = true;
  }
  if (flags.traceId !== undefined) {
    out.traceId = flags.traceId;
  }
  return /** @type {LoggingPolicy} */ (Object.freeze(out));
}

/**
 * @param {import("./cli/flags.mjs").ParsedFlags} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {CostPolicy}
 */
function resolveCost(flags, env) {
  /** @type {{ logPath?: string, disabled?: boolean, pricingOverride?: string }} */
  const out = {};
  if (flags.noCostLog === true) {
    out.disabled = true;
  } else {
    const costLog = flags.costLog ?? env.ARTAGON_COST_LOG;
    if (costLog !== undefined && costLog.length > 0) {
      validateWritableDir(costLog, "--cost-log/ARTAGON_COST_LOG");
      out.logPath = costLog;
    }
  }
  const pricing = flags.pricing ?? env.ARTAGON_PRICING_OVERRIDE;
  if (pricing !== undefined && pricing.length > 0) {
    if (!fs.existsSync(pricing)) {
      throw new Error(`--pricing/ARTAGON_PRICING_OVERRIDE path does not exist: ${pricing}`);
    }
    out.pricingOverride = pricing;
  }
  return /** @type {CostPolicy} */ (Object.freeze(out));
}

/**
 * Translate `--session <id>` / `--new-session` into a SessionPolicy.
 * Pure flag-driven — there is no env-var fallback for session intent;
 * sessions are per-invocation, not per-host.
 *
 * @param {import("./cli/flags.mjs").ParsedFlags} flags
 * @returns {SessionPolicy}
 */
function resolveSession(flags) {
  if (flags.newSession === true) {
    return /** @type {SessionPolicy} */ (Object.freeze({ action: "fresh" }));
  }
  if (flags.sessionId !== undefined) {
    return /** @type {SessionPolicy} */ (Object.freeze({ action: "resume", id: flags.sessionId }));
  }
  return /** @type {SessionPolicy} */ (Object.freeze({ action: "reuse" }));
}

/**
 * @param {import("./cli/flags.mjs").ParsedFlags} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {FacadePolicy}
 */
function resolveFacade(flags, env) {
  /** @type {{ apiKey?: string, cors?: string }} */
  const out = {};
  const apiKey = flags.facadeKey ?? env.ARTAGON_FACADE_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    out.apiKey = apiKey;
  }
  if (env.ARTAGON_FACADE_CORS !== undefined && env.ARTAGON_FACADE_CORS.length > 0) {
    out.cors = env.ARTAGON_FACADE_CORS;
  }
  return /** @type {FacadePolicy} */ (Object.freeze(out));
}

/**
 * Map a "1" / "0" / unset env value to a TriState. Anything else
 * (typo, garbage) is treated as unset.
 *
 * @param {string | undefined} value
 * @returns {TriState | undefined}
 */
function triFromEnvBool(value) {
  if (value === "1") return "on";
  if (value === "0") return "off";
  return undefined;
}

/**
 * Merge a CLI-flag tri-state with an env-var-derived tri-state. Throws
 * on disagreement with both sources cited.
 *
 * @param {string} flagToken
 * @param {TriState | undefined} flagValue
 * @param {string} envKey
 * @param {TriState | undefined} envValue
 * @returns {TriState}
 */
function mergeTri(flagToken, flagValue, envKey, envValue) {
  if (flagValue !== undefined && envValue !== undefined && flagValue !== envValue) {
    throw new Error(
      `Conflicting config: ${flagToken}=${flagValue} but ${envKey}=${envValue === "on" ? "1" : "0"} in env. Unset one.`
    );
  }
  return flagValue ?? envValue ?? "default";
}

/**
 * Verify the dirname of `filePath` is writable. Throws with the
 * specific path on failure so the user sees the offending value.
 *
 * @param {string} filePath
 * @param {string} sourceLabel
 */
function validateWritableDir(filePath, sourceLabel) {
  const dir = path.dirname(filePath);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    const code = err instanceof Error && /** @type {any} */ (err).code;
    if (code === "ENOENT") {
      // Try to mkdir -p so the user doesn't have to pre-create $XDG dirs.
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return;
      } catch (mkErr) {
        throw new Error(
          `${sourceLabel}: directory does not exist and cannot be created: ${dir}` +
            ` (${mkErr instanceof Error ? mkErr.message : String(mkErr)})`
        );
      }
    }
    throw new Error(`${sourceLabel}: directory is not writable: ${dir} (${code ?? err})`);
  }
}

/**
 * Scan `env` for keys matching the internal-config prefixes. Unknown
 * keys (typos like `ARTAGON_STREMING`) trigger a stderr warning or,
 * under strict mode, throw. The Levenshtein-style "did you mean"
 * suggestion is a single-edit nearest match against KNOWN_INTERNAL_ENV_KEYS.
 *
 * Exported so long-lived daemons (`bin/artagon-openai-server.mjs`)
 * that build their context directly via `createAgentContext` — without
 * going through `buildAgentContextFromArgv` — can still surface the
 * env-typo check at boot.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ strict: boolean }} opts
 */
export function auditEnvKeys(env, opts) {
  const unknown = [];
  for (const key of Object.keys(env)) {
    if (KNOWN_INTERNAL_ENV_KEYS.has(key)) continue;
    if (key.startsWith("ARTAGON_") || key.startsWith("ACP_WIRE_LOG")) {
      unknown.push(key);
    }
  }
  if (unknown.length === 0) return;
  const messages = unknown.map((key) => {
    const guess = nearestKnownKey(key);
    return guess
      ? `unknown internal env var: ${key} (did you mean ${guess}?)`
      : `unknown internal env var: ${key}`;
  });
  if (opts.strict) {
    throw new Error(`[agent-context] strict env check failed:\n  ${messages.join("\n  ")}`);
  }
  for (const message of messages) {
    process.stderr.write(`[agent-context] warn: ${message}\n`);
  }
}

/**
 * Return the known internal env-var key with the smallest edit
 * distance to `key`, OR null when no candidate is within a small
 * threshold. Used for "did you mean" hints in env audit warnings.
 *
 * @param {string} key
 * @returns {string | null}
 */
function nearestKnownKey(key) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_INTERNAL_ENV_KEYS) {
    const d = editDistance(key, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Threshold of 3 keeps "ARTAGON_STREMING" → "ARTAGON_STREAMING" (d=1)
  // but rejects unrelated tokens (d=10+).
  return bestDistance <= 3 ? best : null;
}

/**
 * Iterative Levenshtein distance. Small inputs (env var names),
 * O(n*m) is fine.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[n];
}
