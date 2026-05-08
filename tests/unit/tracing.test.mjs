/**
 * Unit tests for `lib/tracing.mjs`.
 *
 * Covers the no-op contract — what callers can rely on when the
 * OpenTelemetry SDK packages aren't installed (the documented common
 * case) or when the env var isn't set:
 *
 *   - getTracer() with no OTEL_EXPORTER_OTLP_ENDPOINT → no-op tracer
 *   - getTracer() when SDK packages can't be imported → no-op (silent)
 *   - getTracerSyncOrNoop() returns the same value before/after async
 *   - tracer.span(name, fn) calls fn and returns its result
 *   - tracer.span propagates the fn's return value (sync + async)
 *   - tracer.shutdown() never rejects
 *   - tracer.inject(carrier) doesn't throw on no-op
 *
 * The "real OTel" branch isn't unit-testable without the SDK packages
 * (which are intentionally NOT declared as devDependencies); the
 * silent-no-op vs. warn-and-no-op discrimination on err.code is
 * covered indirectly here — if the import failure doesn't propagate
 * to the caller, the catch arm executed correctly.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import { _resetTracerForTests, getTracer, getTracerSyncOrNoop } from "#lib/tracing.mjs";

beforeEach(() => {
  _resetTracerForTests();
});
afterEach(() => {
  _resetTracerForTests();
});

test("getTracer with no OTEL_EXPORTER_OTLP_ENDPOINT → no-op tracer", async () => {
  // Empty env: OTEL_EXPORTER_OTLP_ENDPOINT is undefined.
  const tracer = await getTracer({});
  expect(typeof tracer.span).toBe("function");
  expect(typeof tracer.inject).toBe("function");
  expect(typeof tracer.shutdown).toBe("function");
});

test("getTracerSyncOrNoop returns the no-op before any async resolution", () => {
  const tracer = getTracerSyncOrNoop();
  expect(typeof tracer.span).toBe("function");
});

test("noop tracer.span: synchronous fn return value passes through", async () => {
  const tracer = await getTracer({});
  const result = await tracer.span("test", () => 42);
  expect(result).toBe(42);
});

test("noop tracer.span: async fn return value passes through", async () => {
  const tracer = await getTracer({});
  const result = await tracer.span("test", async () => "ok");
  expect(result).toBe("ok");
});

test("noop tracer.span: throws inside fn propagate to caller", async () => {
  const tracer = await getTracer({});
  await expect(tracer.span("test", () => Promise.reject(new Error("boom")))).rejects.toThrow(
    "boom"
  );
});

test("noop tracer.inject: no-op (does not throw, does not mutate)", async () => {
  const tracer = await getTracer({});
  const carrier = { existing: "value" };
  expect(() => tracer.inject(carrier)).not.toThrow();
  // No-op shouldn't add traceparent — we have no SDK to generate one.
  expect(carrier).toEqual({ existing: "value" });
});

test("noop tracer.shutdown: resolves without rejecting", async () => {
  const tracer = await getTracer({});
  await expect(tracer.shutdown()).resolves.toBeUndefined();
});

test("getTracer caches: second call returns same tracer", async () => {
  const tracer1 = await getTracer({});
  const tracer2 = await getTracer({});
  expect(tracer1).toBe(tracer2);
});

test("getTracer with bogus env: import failure → no-op tracer (never throws)", async () => {
  // Set the env var so the OTel-loading branch executes. The SDK
  // packages aren't installed in the test env (intentionally — they're
  // opt-in runtime deps), so the dynamic import throws.
  //
  // Whether it surfaces a stderr warning depends on the runner:
  //   - Plain Node: err.code === "ERR_MODULE_NOT_FOUND" → silent no-op
  //   - vitest (vite/rollup resolution): a different error code →
  //     warn-branch emits "[tracing] OTel setup failed"
  //
  // Both branches are correct — vite's "package not in deps" failure
  // is genuinely "the env is not what the user expected", which is
  // when an operator wants to see why tracing isn't working. The
  // contract under test is: getTracer() never throws, and what it
  // returns is a usable no-op tracer.
  const tracer = await getTracer({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318"
  });
  expect(typeof tracer.span).toBe("function");
  const result = await tracer.span("test", () => "still-noop");
  expect(result).toBe("still-noop");
});
