/**
 * Unit tests for `lib/agent-context.mjs`.
 *
 * Coverage groups:
 *
 *   createAgentContext    defaults, full-config, deep freeze, invariants,
 *                         schemaVersion stamp
 *   withOverrides         purity (original untouched), sub-policy
 *                         shallow merge, returned frozen
 *   buildAgentContextFromArgv
 *                         flag → context mapping, env fallback,
 *                         mixed-source disagreement, env audit warnings,
 *                         strict mode, helpRequested branch, tri-state
 *                         env conversion
 *
 * Filesystem-sensitive flags (--wire-log path / --cost-log path /
 * --pricing path) ARE validated by the boundary builder — these tests
 * use real tmp paths to avoid mocking fs.
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  buildAgentContextFromArgv,
  createAgentContext,
  migrateAgentContext,
  withOverrides
} from "#lib/agent-context.mjs";

/** @type {string} */
let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join("/tmp", "agent-ctx-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// createAgentContext
// ──────────────────────────────────────────────────────────────────────

describe("createAgentContext", () => {
  test("empty input → defaults populated, schemaVersion=1", () => {
    const ctx = createAgentContext();
    expect(ctx.schemaVersion).toBe(1);
    expect(ctx.dispatch).toEqual({
      streaming: "default",
      facade: "default",
      broker: "auto"
    });
    expect(ctx.logging).toEqual({});
    expect(ctx.cost).toEqual({});
    expect(ctx.facade).toEqual({});
    expect(typeof ctx.cwd).toBe("string");
    expect(ctx.env).toBe(process.env);
  });

  test("partial dispatch override merges with defaults", () => {
    const ctx = createAgentContext({ dispatch: { streaming: "on" } });
    expect(ctx.dispatch).toEqual({
      streaming: "on",
      facade: "default",
      broker: "auto"
    });
  });

  test("model / timeoutMs / debug propagate", () => {
    const ctx = createAgentContext({
      model: "sonnet",
      timeoutMs: 30000,
      debug: true
    });
    expect(ctx.model).toBe("sonnet");
    expect(ctx.timeoutMs).toBe(30000);
    expect(ctx.debug).toBe(true);
  });

  test("outer context is frozen — direct property mutation throws in strict mode", () => {
    const ctx = createAgentContext();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      /** @type {any} */ (ctx).cwd = "/somewhere";
    }).toThrow(TypeError);
  });

  test("dispatch sub-policy is frozen (the critical deep-freeze case)", () => {
    const ctx = createAgentContext();
    expect(Object.isFrozen(ctx.dispatch)).toBe(true);
    expect(() => {
      /** @type {any} */ (ctx.dispatch).streaming = "on";
    }).toThrow(TypeError);
  });

  test("logging / cost / facade sub-policies are frozen", () => {
    const ctx = createAgentContext();
    expect(Object.isFrozen(ctx.logging)).toBe(true);
    expect(Object.isFrozen(ctx.cost)).toBe(true);
    expect(Object.isFrozen(ctx.facade)).toBe(true);
    expect(() => {
      /** @type {any} */ (ctx.logging).wireLogPath = "/x";
    }).toThrow(TypeError);
  });

  test("dispatch.facade='on' without apiKey → throws with actionable message", () => {
    expect(() => createAgentContext({ dispatch: { facade: "on" } })).toThrow(
      /facade.*apiKey.*--facade-key/
    );
  });

  test("dispatch.facade='on' with apiKey → no throw", () => {
    expect(() =>
      createAgentContext({
        dispatch: { facade: "on" },
        facade: { apiKey: "tok" }
      })
    ).not.toThrow();
  });

  test("cost.disabled=true AND cost.logPath set → throws", () => {
    expect(() => createAgentContext({ cost: { disabled: true, logPath: "/tmp/x.jsonl" } })).toThrow(
      /mutually exclusive/
    );
  });

  test("timeoutMs invariants: NaN/0/negative/Infinity all throw", () => {
    expect(() => createAgentContext({ timeoutMs: Number.NaN })).toThrow(/finite positive/);
    expect(() => createAgentContext({ timeoutMs: 0 })).toThrow(/finite positive/);
    expect(() => createAgentContext({ timeoutMs: -5 })).toThrow(/finite positive/);
    expect(() => createAgentContext({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      /finite positive/
    );
  });

  test("model must be a non-empty string when set", () => {
    expect(() => createAgentContext({ model: "" })).toThrow(/non-empty/);
    expect(() => createAgentContext({ model: /** @type {any} */ (123) })).toThrow(/non-empty/);
  });

  test("env field passes through as-is (not deep-frozen, by design)", () => {
    const custom = { ARTAGON_TEST_KEY: "value" };
    const ctx = createAgentContext({ env: /** @type {any} */ (custom) });
    expect(ctx.env).toBe(custom);
  });

  test("env field stays mutable so spawned children inherit live changes — documented contract", () => {
    // The outer context is frozen, but `context.env` is intentionally
    // NOT (per the typedef): `NodeJS.ProcessEnv` is what
    // `child_process.spawn` reads to construct the child's environment,
    // and tests / wrappers commonly add keys to it just before spawn.
    // Freezing it would surprise callers in ways that don't fit the
    // "internal config in context, host env unchanged" contract.
    const custom = { FOO: "bar" };
    const ctx = createAgentContext({ env: /** @type {any} */ (custom) });
    expect(Object.isFrozen(ctx.env)).toBe(false);
    // Demonstrate: live mutation is intentionally possible.
    /** @type {any} */ (ctx.env).BAZ = "qux";
    expect(ctx.env.BAZ).toBe("qux");
  });
});

// ──────────────────────────────────────────────────────────────────────
// withOverrides
// ──────────────────────────────────────────────────────────────────────

describe("migrateAgentContext", () => {
  test("returns the context unchanged when schemaVersion === 1", () => {
    const ctx = createAgentContext();
    expect(migrateAgentContext(ctx)).toBe(ctx);
  });

  test("throws on unknown schemaVersion with the offending value cited", () => {
    expect(() => migrateAgentContext({ schemaVersion: 2 })).toThrow(
      /unsupported schemaVersion 2.*expected 1/
    );
    expect(() => migrateAgentContext({ schemaVersion: "1" })).toThrow(
      /unsupported schemaVersion "1".*expected 1/
    );
  });

  test("throws on missing schemaVersion", () => {
    expect(() => migrateAgentContext({})).toThrow(/unsupported schemaVersion undefined/);
  });

  test("throws on non-object input", () => {
    expect(() => migrateAgentContext(/** @type {any} */ (null))).toThrow(TypeError);
    expect(() => migrateAgentContext(/** @type {any} */ ("ctx"))).toThrow(TypeError);
  });
});

describe("withOverrides", () => {
  test("returns a NEW context; original untouched", () => {
    const base = createAgentContext({ model: "sonnet" });
    const derived = withOverrides(base, { model: "opus" });
    expect(derived.model).toBe("opus");
    expect(base.model).toBe("sonnet"); // untouched
    expect(derived).not.toBe(base);
  });

  test("sub-policies are shallow-merged: unmentioned fields preserved", () => {
    const base = createAgentContext({
      dispatch: { streaming: "on", facade: "default", broker: "disabled" }
    });
    const derived = withOverrides(base, { dispatch: { streaming: "off" } });
    expect(derived.dispatch).toEqual({
      streaming: "off",
      facade: "default",
      broker: "disabled"
    });
  });

  test("returned context is frozen", () => {
    const base = createAgentContext();
    const derived = withOverrides(base, { debug: true });
    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived.dispatch)).toBe(true);
  });

  test("withOverrides({}) returns a structurally-equivalent context", () => {
    const base = createAgentContext({ model: "sonnet", timeoutMs: 5000 });
    const derived = withOverrides(base);
    expect(derived.model).toBe("sonnet");
    expect(derived.timeoutMs).toBe(5000);
    expect(derived.dispatch).toEqual(base.dispatch);
  });

  test("withOverrides re-runs invariants on the merged result", () => {
    const base = createAgentContext({ facade: { apiKey: "tok" } });
    // Removing apiKey while turning facade on should fail invariant.
    expect(() =>
      withOverrides(base, {
        dispatch: { facade: "on" },
        facade: { apiKey: undefined }
      })
    ).toThrow(/facade.*apiKey/);
  });

  test("throws when ctx is not an object", () => {
    expect(() => withOverrides(/** @type {any} */ (null), {})).toThrow(TypeError);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildAgentContextFromArgv — flag mapping
// ──────────────────────────────────────────────────────────────────────

describe("buildAgentContextFromArgv:flag-mapping", () => {
  test("bare prompt → defaults + the prompt", () => {
    const { context, prompt } = buildAgentContextFromArgv(["hello", "world"], emptyEnv());
    expect(prompt).toBe("hello world");
    expect(context.dispatch.streaming).toBe("default");
  });

  test("--streaming maps to dispatch.streaming = 'on'", () => {
    const { context } = buildAgentContextFromArgv(["--streaming", "x"], emptyEnv());
    expect(context.dispatch.streaming).toBe("on");
  });

  test("--no-broker maps to dispatch.broker = 'disabled'", () => {
    const { context } = buildAgentContextFromArgv(["--no-broker", "x"], emptyEnv());
    expect(context.dispatch.broker).toBe("disabled");
  });

  test("--wire-log <path> maps to logging.wireLogPath; path validated", () => {
    const p = path.join(tmpDir, "wire.jsonl");
    const { context } = buildAgentContextFromArgv(["--wire-log", p, "x"], emptyEnv());
    expect(context.logging.wireLogPath).toBe(p);
  });

  test("--wire-log with non-existent dirname triggers mkdir (no throw on common case)", () => {
    const p = path.join(tmpDir, "subdir", "wire.jsonl");
    expect(() => buildAgentContextFromArgv(["--wire-log", p, "x"], emptyEnv())).not.toThrow();
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  test("--cost-log + --no-cost-log conflict caught", () => {
    expect(() =>
      buildAgentContextFromArgv(["--cost-log", "/tmp/x", "--no-cost-log", "prompt"], emptyEnv())
    ).toThrow(/mutually exclusive/);
  });

  test("--pricing path that doesn't exist → throws", () => {
    expect(() =>
      buildAgentContextFromArgv(["--pricing", "/no/such/file.json", "x"], emptyEnv())
    ).toThrow(/does not exist/);
  });

  test("--pricing existing file → ok", () => {
    const p = path.join(tmpDir, "pricing.json");
    fs.writeFileSync(p, "{}");
    const { context } = buildAgentContextFromArgv(["--pricing", p, "x"], emptyEnv());
    expect(context.cost.pricingOverride).toBe(p);
  });

  test("--timeout / --model / --cwd / --debug propagate", () => {
    const { context } = buildAgentContextFromArgv(
      ["--timeout", "30000", "--model", "sonnet", "--cwd", tmpDir, "--debug", "x"],
      emptyEnv()
    );
    expect(context.timeoutMs).toBe(30000);
    expect(context.model).toBe("sonnet");
    expect(context.cwd).toBe(tmpDir);
    expect(context.debug).toBe(true);
  });

  test("helpRequested branch returns a default context + prompt", () => {
    const r = buildAgentContextFromArgv(["--help"], emptyEnv());
    expect(r.helpRequested).toBe(true);
    expect(r.context).toBeTruthy();
  });

  test("--trace-id maps to logging.traceId", () => {
    const { context } = buildAgentContextFromArgv(["--trace-id", "req-42", "x"], emptyEnv());
    expect(context.logging.traceId).toBe("req-42");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildAgentContextFromArgv — env fallback
// ──────────────────────────────────────────────────────────────────────

describe("buildAgentContextFromArgv:env-fallback", () => {
  test("ARTAGON_STREAMING=1 → dispatch.streaming = 'on' when flag absent", () => {
    const env = withVar("ARTAGON_STREAMING", "1");
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.dispatch.streaming).toBe("on");
  });

  test("ARTAGON_STREAMING=0 → dispatch.streaming = 'off' when flag absent", () => {
    const env = withVar("ARTAGON_STREAMING", "0");
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.dispatch.streaming).toBe("off");
  });

  test("ARTAGON_USE_FACADE=1 + ARTAGON_FACADE_API_KEY → facade=on resolved", () => {
    const env = {
      ...emptyEnv(),
      ARTAGON_USE_FACADE: "1",
      ARTAGON_FACADE_API_KEY: "tok"
    };
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.dispatch.facade).toBe("on");
    expect(context.facade.apiKey).toBe("tok");
  });

  test("ARTAGON_DISABLE_BROKER=1 → broker = 'disabled'", () => {
    const env = withVar("ARTAGON_DISABLE_BROKER", "1");
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.dispatch.broker).toBe("disabled");
  });

  test("ACP_WIRE_LOG fallback maps to logging.wireLogPath", () => {
    const p = path.join(tmpDir, "fallback.jsonl");
    const env = withVar("ACP_WIRE_LOG", p);
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.logging.wireLogPath).toBe(p);
  });

  test("ARTAGON_COST_LOG fallback maps to cost.logPath", () => {
    const p = path.join(tmpDir, "cost.jsonl");
    const env = withVar("ARTAGON_COST_LOG", p);
    const { context } = buildAgentContextFromArgv(["x"], env);
    expect(context.cost.logPath).toBe(p);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildAgentContextFromArgv — mixed-source disagreement
// ──────────────────────────────────────────────────────────────────────

describe("buildAgentContextFromArgv:mixed-source", () => {
  test("--streaming flag + ARTAGON_STREAMING=0 → throws with both sources cited", () => {
    const env = withVar("ARTAGON_STREAMING", "0");
    expect(() => buildAgentContextFromArgv(["--streaming", "x"], env)).toThrow(
      /--streaming.*ARTAGON_STREAMING.*Unset one/
    );
  });

  test("--streaming flag + ARTAGON_STREAMING=1 → agreement, no throw", () => {
    const env = withVar("ARTAGON_STREAMING", "1");
    expect(() => buildAgentContextFromArgv(["--streaming", "x"], env)).not.toThrow();
  });

  test("--no-broker + ARTAGON_DISABLE_BROKER=0 → throws (negative env hint contradicts flag)", () => {
    const env = withVar("ARTAGON_DISABLE_BROKER", "0");
    expect(() => buildAgentContextFromArgv(["--no-broker", "x"], env)).toThrow(
      /--no-broker.*ARTAGON_DISABLE_BROKER/
    );
  });

  test("--facade flag + ARTAGON_USE_FACADE=0 → throws with both sources cited", () => {
    // Sibling to the streaming case; same mergeTri code path. Without
    // this test, the facade-tri-state branch is unverified.
    const env = {
      ...withVar("ARTAGON_USE_FACADE", "0"),
      ARTAGON_FACADE_API_KEY: "tok"
    };
    expect(() => buildAgentContextFromArgv(["--facade", "x"], env)).toThrow(
      /--facade.*ARTAGON_USE_FACADE.*Unset one/
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildAgentContextFromArgv — env audit (typo detection)
// ──────────────────────────────────────────────────────────────────────

describe("buildAgentContextFromArgv:env-audit", () => {
  test("typo'd ARTAGON_STREMING warns on stderr with `did you mean` hint", () => {
    const env = withVar("ARTAGON_STREMING", "1");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      buildAgentContextFromArgv(["x"], env);
      const calls = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(calls).toMatch(/ARTAGON_STREMING/);
      expect(calls).toMatch(/did you mean ARTAGON_STREAMING/);
    } finally {
      spy.mockRestore();
    }
  });

  test("under --strict-env, unknown env throws instead of warning", () => {
    const env = withVar("ARTAGON_BOGUS", "1");
    expect(() => buildAgentContextFromArgv(["--strict-env", "x"], env)).toThrow(
      /strict env.*ARTAGON_BOGUS/s
    );
  });

  test("ARTAGON_STRICT_ENV=1 env enables strict mode", () => {
    const env = {
      ...emptyEnv(),
      ARTAGON_STRICT_ENV: "1",
      ARTAGON_TYPOED_KEY: "1"
    };
    expect(() => buildAgentContextFromArgv(["x"], env)).toThrow(/strict env/);
  });

  test("known internal keys do NOT trigger warnings", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      buildAgentContextFromArgv(["x"], {
        ...emptyEnv(),
        ARTAGON_STREAMING: "1",
        ACP_WIRE_LOG: "/tmp/x.jsonl"
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("env vars OUTSIDE the internal prefixes are ignored entirely", () => {
    const env = {
      ...emptyEnv(),
      ANTHROPIC_API_KEY: "external",
      XDG_STATE_HOME: "/x",
      CLAUDE_PLUGIN_ROOT: "/y"
    };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { context } = buildAgentContextFromArgv(["x"], env);
      expect(context.env).toBe(env);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Return an env object with NONE of our internal keys present. The
 * boundary builder treats every internal-prefix key it doesn't
 * recognize as a typo, so tests must start from a clean slate.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function emptyEnv() {
  return /** @type {NodeJS.ProcessEnv} */ ({});
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {NodeJS.ProcessEnv}
 */
function withVar(key, value) {
  return /** @type {NodeJS.ProcessEnv} */ ({ [key]: value });
}
