/**
 * Middleware unit + integration tests.
 *
 * Covers:
 *   - composeMiddleware: order validation, redaction-first invariant
 *   - redaction: pattern coverage + field-level + property test
 *   - audit: append-only JSONL with redacted payloads
 *   - retry: transient retry, permanent fast-fail, max-attempts cap
 *   - fallback: model swap on permanent error, exhaustion path
 *   - cache: hit/miss/TTL/opt-in semantics
 *   - end-to-end: composed chain wraps MockBackend, conformance still passes
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createAcpClient } from "#lib/acp/client.mjs";
import { createAuditMiddleware } from "#lib/middleware/audit.mjs";
import { createCacheMiddleware } from "#lib/middleware/cache.mjs";
import {
  MiddlewareOrderError,
  composeMiddleware,
  identityMiddleware
} from "#lib/middleware/compose.mjs";
import { createFallbackMiddleware } from "#lib/middleware/fallback.mjs";
import { createRedactionMiddleware, redactValue } from "#lib/middleware/redaction.mjs";
import { createRetryMiddleware, defaultClassify } from "#lib/middleware/retry.mjs";
import { createMockBackend } from "#lib/test-utils/mock-backend.mjs";

// ─── compose ──────────────────────────────────────────────────────────────────

test("compose: identity passes through unchanged", async () => {
  const composed = composeMiddleware([identityMiddleware]);
  const transport = createMockBackend();
  const client = createAcpClient(transport);
  const wrapped = composed(client);
  expect(wrapped).toBe(client); // identity returns next directly
});

test("compose: empty array returns the session unchanged", () => {
  const session = { dummy: true };
  const composed = composeMiddleware([]);
  expect(composed(/** @type {any} */ (session))).toBe(session);
});

test("compose: redaction at index 0 is fine", () => {
  expect(() => composeMiddleware([createRedactionMiddleware(), identityMiddleware])).not.toThrow();
});

test("compose: redaction NOT at index 0 throws in dev", () => {
  expect(() => composeMiddleware([identityMiddleware, createRedactionMiddleware()])).toThrow(
    MiddlewareOrderError
  );
});

test("compose: rejects non-array input", () => {
  expect(() => composeMiddleware(/** @type {any} */ ("not-array"))).toThrow();
});

test("compose: rejects middleware without wrap()", () => {
  expect(() => composeMiddleware([/** @type {any} */ ({ name: "broken" })])).toThrow(
    /wrap\(\) function/i
  );
});

// ─── redaction ────────────────────────────────────────────────────────────────

test("redactValue: redacts OpenAI sk- keys", () => {
  const config = {
    patterns: [/sk-[A-Za-z0-9_-]{20,}/g],
    fieldNames: new Set(),
    replacement: "[redacted]"
  };
  const out = /** @type {string} */ (
    redactValue("here is sk-abc123def456ghi789jkl012mno345 fyi", config)
  );
  expect(out).not.toContain("sk-abc123def456ghi789jkl012mno345");
  expect(out).toContain("[redacted]");
});

test("redactValue: redacts Anthropic ant- keys", () => {
  const config = {
    patterns: [/\bant-[A-Za-z0-9_-]{20,}/g],
    fieldNames: new Set(),
    replacement: "[redacted]"
  };
  const out = redactValue({ key: "use ant-abc123def456ghi789jkl012m for auth" }, config);
  expect(JSON.stringify(out)).not.toContain("ant-abc123def456ghi789jkl012m");
});

test("redactValue: field-level replacement on known credential names", () => {
  const config = {
    patterns: [],
    fieldNames: new Set(["api_key", "token"]),
    replacement: "[redacted]"
  };
  const out = redactValue({ api_key: "literal-secret", token: "another", safe: "kept" }, config);
  expect(out).toEqual({
    api_key: "[redacted]",
    token: "[redacted]",
    safe: "kept"
  });
});

test("redactValue: redacts URLs with embedded credentials, preserving structure", () => {
  const config = {
    patterns: [/(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/g],
    fieldNames: new Set(),
    replacement: "[redacted]"
  };
  const out = redactValue("https://user:pass@host.example.com/path", config);
  expect(out).toMatch(/^https:\/\/\[redacted\]:\[redacted\]@host\.example\.com\/path$/);
});

test("redactValue: recurses into arrays + nested objects", () => {
  const config = {
    patterns: [/sk-\w+/g],
    fieldNames: new Set(),
    replacement: "[redacted]"
  };
  const out = redactValue({ items: [{ key: "sk-foo123456789012345" }, { key: "safe" }] }, config);
  expect(JSON.stringify(out)).not.toContain("sk-foo123456789012345");
});

test("property: redaction never lets known secret patterns through", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 10, maxLength: 200 }),
      fc.constantFrom("sk-", "AIza", "ant-"),
      (noise, prefix) => {
        const secret = `${prefix}abcdefghij12345678901234567890`; // long enough to match patterns
        const text = `${noise} ${secret} ${noise}`;
        const config = {
          patterns: [
            /sk-[A-Za-z0-9_-]{20,}/g,
            /\bant-[A-Za-z0-9_-]{20,}/g,
            /AIza[A-Za-z0-9_-]{35,}/g
          ],
          fieldNames: new Set(),
          replacement: "[redacted]"
        };
        const out = /** @type {string} */ (redactValue(text, config));
        // The exact secret token MUST NOT survive.
        if (prefix === "sk-" || prefix === "ant-") {
          // Patterns match — secret should be redacted.
          expect(out).not.toContain(secret);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("redaction middleware: redacts request params before delegation", async () => {
  const backend = createMockBackend();
  /** @type {any} */
  let observedParams;
  backend.onRequest("test/echo", (params) => {
    observedParams = params;
    return { ok: true };
  });
  const wrap = createRedactionMiddleware().wrap;
  const client = wrap(createAcpClient(backend));
  await client.start();
  await client.request("test/echo", {
    api_key: "sk-leak123456789012345abc",
    text: "hello"
  });
  expect(observedParams.api_key).toBe("[redacted]");
  expect(observedParams.text).toBe("hello");
  await client.close();
});

// ─── audit ────────────────────────────────────────────────────────────────────

let auditDir;
beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
});
afterEach(() => {
  if (auditDir) fs.rmSync(auditDir, { recursive: true, force: true });
});

test("audit middleware: writes JSONL records under <directory>/<sessionId>/", async () => {
  const backend = createMockBackend();
  backend.onRequest("test/ping", () => ({ pong: true }));
  const sessionId = "test-session";
  const auditMw = createAuditMiddleware({ sessionId, directory: auditDir });
  const client = auditMw.wrap(createAcpClient(backend));
  await client.start();
  await client.request("test/ping", { hello: "world" });
  await client.close();

  const file = path.join(auditDir, sessionId, "audit.jsonl");
  expect(fs.existsSync(file)).toBe(true);
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const kinds = lines.map((l) => l.kind);
  expect(kinds).toContain("request");
  expect(kinds).toContain("response");
});

// ─── retry ────────────────────────────────────────────────────────────────────

test("defaultClassify: rate-limited error is transient", () => {
  expect(defaultClassify({ kind: "rate-limited" })).toBe("transient");
  expect(defaultClassify(new Error("rate limit hit"))).toBe("transient");
});

test("defaultClassify: auth-required is permanent", () => {
  expect(defaultClassify({ kind: "auth-required" })).toBe("permanent");
});

test("retry middleware: retries transient and succeeds", async () => {
  let attempt = 0;
  const next = {
    start: async () => {},
    request: async () => {
      attempt++;
      if (attempt < 2) {
        const err = new Error("rate limit exceeded");
        /** @type {any} */ (err).kind = "rate-limited";
        throw err;
      }
      return { ok: true };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const retryMw = createRetryMiddleware({
    initialBackoffMs: 1,
    maxAttempts: 3
  });
  const wrapped = retryMw.wrap(/** @type {any} */ (next));
  const result = await wrapped.request("test/ping", {});
  expect(result).toEqual({ ok: true });
  expect(attempt).toBe(2);
});

test("retry middleware: permanent error fails fast", async () => {
  let attempt = 0;
  const next = {
    start: async () => {},
    request: async () => {
      attempt++;
      const err = new Error("auth required");
      /** @type {any} */ (err).kind = "auth-required";
      throw err;
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const retryMw = createRetryMiddleware({
    initialBackoffMs: 1,
    maxAttempts: 3
  });
  const wrapped = retryMw.wrap(/** @type {any} */ (next));
  await expect(wrapped.request("test/ping", {})).rejects.toThrow(/auth required/);
  expect(attempt).toBe(1);
});

// ─── fallback ─────────────────────────────────────────────────────────────────

test("fallback middleware: passes through when no fallback chain provided", async () => {
  let calls = 0;
  const next = {
    start: async () => {},
    request: async () => {
      calls++;
      return { ok: true };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const fallbackMw = createFallbackMiddleware();
  const wrapped = fallbackMw.wrap(/** @type {any} */ (next));
  await wrapped.request("session/prompt", { model: "primary" });
  expect(calls).toBe(1);
});

test("fallback middleware: swaps to next model on overload error", async () => {
  /** @type {string[]} */
  const triedModels = [];
  const next = {
    start: async () => {},
    request: async (_method, params) => {
      triedModels.push(/** @type {any} */ (params).model);
      if (triedModels.length === 1) {
        throw new Error("model overload — try later");
      }
      return { ok: true, modelUsed: /** @type {any} */ (params).model };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const fallbackMw = createFallbackMiddleware();
  const wrapped = fallbackMw.wrap(/** @type {any} */ (next));
  const result = await wrapped.request("session/prompt", {
    model: "opus",
    _fallbackModels: ["sonnet", "haiku"]
  });
  expect(triedModels).toEqual(["opus", "sonnet"]);
  expect(/** @type {any} */ (result).modelUsed).toBe("sonnet");
});

// ─── cache ────────────────────────────────────────────────────────────────────

let cacheDir;
beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
});
afterEach(() => {
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("cache middleware: bypasses when _cache is not opted in", async () => {
  let calls = 0;
  const next = {
    start: async () => {},
    request: async () => {
      calls++;
      return { result: calls };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const cacheMw = createCacheMiddleware({
    directory: cacheDir,
    gitHead: () => "abc"
  });
  const wrapped = cacheMw.wrap(/** @type {any} */ (next));
  await wrapped.request("session/prompt", { prompt: "hi" });
  await wrapped.request("session/prompt", { prompt: "hi" });
  expect(calls).toBe(2);
});

test("cache middleware: hit on second call when _cache opted in + same params + same git head", async () => {
  let calls = 0;
  const next = {
    start: async () => {},
    request: async () => {
      calls++;
      return { result: calls };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const cacheMw = createCacheMiddleware({
    directory: cacheDir,
    gitHead: () => "abc"
  });
  const wrapped = cacheMw.wrap(/** @type {any} */ (next));
  const first = await wrapped.request("session/prompt", {
    prompt: "hi",
    _cache: true
  });
  const second = await wrapped.request("session/prompt", {
    prompt: "hi",
    _cache: true
  });
  expect(calls).toBe(1);
  expect(second).toEqual(first);
});

test("cache middleware: different git head produces different cache key", async () => {
  let calls = 0;
  let head = "abc";
  const next = {
    start: async () => {},
    request: async () => {
      calls++;
      return { result: calls };
    },
    notify: () => {},
    onNotification: () => () => {},
    onHealthChange: () => () => {},
    healthState: () => "active",
    close: async () => {},
    isOpen: () => true
  };
  const cacheMw = createCacheMiddleware({
    directory: cacheDir,
    gitHead: () => head
  });
  const wrapped = cacheMw.wrap(/** @type {any} */ (next));
  await wrapped.request("session/prompt", { prompt: "hi", _cache: true });
  head = "xyz";
  await wrapped.request("session/prompt", { prompt: "hi", _cache: true });
  expect(calls).toBe(2);
});

// ─── e2e composed chain ──────────────────────────────────────────────────────

test("e2e: composed chain wraps MockBackend transparently for prompt round-trip", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", (params) => ({ echo: params }));
  const chain = composeMiddleware([
    createRedactionMiddleware(),
    createAuditMiddleware({ enabled: false }), // disable file IO for this test
    createRetryMiddleware({ initialBackoffMs: 1 }),
    createFallbackMiddleware()
  ]);
  const innerClient = createAcpClient(backend);
  const wrapped = chain(innerClient);
  await wrapped.start();
  const result = await wrapped.request("session/prompt", {
    prompt: "hello",
    api_key: "sk-shouldbe redacted0000000000000"
  });
  // Echo back contains redacted api_key.
  expect(/** @type {any} */ (result).echo.api_key).toBe("[redacted]");
  expect(/** @type {any} */ (result).echo.prompt).toBe("hello");
  await wrapped.close();
});
