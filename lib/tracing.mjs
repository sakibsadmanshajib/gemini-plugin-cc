/**
 * OpenTelemetry tracing — lazy-loaded and opt-in via env.
 *
 * Activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Default endpoint
 * for local Jaeger/Tempo: `http://localhost:4318`. Trace context propagates
 * via a non-standard `_otel.traceparent` extension field on ACP messages
 * (see `add-testing-and-observability` proposal — backend CLIs ignore
 * unknown fields, so propagation is non-breaking but spans terminate at
 * the subprocess boundary unless the backend implements its own propagation).
 *
 * Why lazy: the OTel SDK is ~150KB and starts a background exporter. If a
 * user never sets `OTEL_EXPORTER_OTLP_ENDPOINT`, we don't pay any cost.
 *
 * Note: `@opentelemetry/sdk-node` and friends are NOT declared as
 * devDependencies. They are runtime opt-in dependencies that users install
 * themselves when they want tracing. This keeps the plugin's installed
 * footprint small for the common case (no tracing).
 */

/**
 * @typedef {{
 *   span(name: string, fn: () => any | Promise<any>): any | Promise<any>,
 *   inject(carrier: object): void,
 *   shutdown(): Promise<void>
 * }} Tracer
 */

/** @type {Tracer | null} */
let cached = null;

/**
 * No-op tracer. Returned when OTel isn't configured. Same shape as the real
 * tracer so call sites can use it unconditionally.
 *
 * @type {Tracer}
 */
const noopTracer = {
  span(_name, fn) {
    return fn();
  },
  inject(_carrier) {},
  async shutdown() {}
};

/**
 * Resolve the active tracer. Lazy-loads `@opentelemetry/*` packages on first
 * call when the env is configured; returns the no-op tracer otherwise.
 *
 * Async to allow the dynamic import. Callers that need synchronous tracing
 * should use `getTracerSyncOrNoop()` (returns no-op until the async path
 * has populated the cache).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Tracer>}
 */
export async function getTracer(env = process.env) {
  if (cached) return cached;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    cached = noopTracer;
    return cached;
  }

  try {
    // Dynamic import keeps OTel out of cold-start and out of the dep graph
    // when the user hasn't installed the OTel SDK packages. The packages
    // are intentionally NOT declared as devDependencies — type-check errors
    // here are expected when the user hasn't opted into tracing. Use
    // // @ts-ignore on each dynamic-import line so tsc passes for the
    // typical install. Runtime safely no-ops via the catch below if
    // packages are absent.
    const [{ trace, context: otContext }, { NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
      // @ts-ignore — opt-in runtime dep, see comment above.
      import("@opentelemetry/api"),
      // @ts-ignore — opt-in runtime dep, see comment above.
      import("@opentelemetry/sdk-node"),
      // @ts-ignore — opt-in runtime dep, see comment above.
      import("@opentelemetry/exporter-trace-otlp-http")
    ]);

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: env.OTEL_EXPORTER_OTLP_ENDPOINT
      })
    });
    sdk.start();

    const tracer = trace.getTracer("acp-plugin-cc");

    cached = {
      span(name, fn) {
        return tracer.startActiveSpan(name, async (span) => {
          try {
            const result = await fn();
            span.end();
            return result;
          } catch (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.end();
            throw err;
          }
        });
      },
      inject(carrier) {
        // W3C traceparent injection — populate carrier.traceparent.
        const propagation = otContext;
        // Best-effort; if propagation API is unavailable, do nothing.
        try {
          /** @type {{ inject?: (ctx: any, carrier: any, setter: any) => void }} */
          const propAny = /** @type {any} */ (propagation);
          if (typeof propAny.inject === "function") {
            propAny.inject(propagation.active(), carrier, {
              set(c, k, v) {
                c[k] = v;
              }
            });
          }
        } catch {
          // Ignore — non-critical.
        }
      },
      async shutdown() {
        try {
          await sdk.shutdown();
        } catch {
          // Ignore.
        }
      }
    };
    return cached;
  } catch (err) {
    // The catch here is broad on purpose — covers (a) the OTel SDK packages
    // not being installed (ERR_MODULE_NOT_FOUND) and (b) any failure during
    // SDK setup (constructor throw, sdk.start() reject, malformed endpoint,
    // version mismatch). For (a) we want a silent no-op (tracing is opt-in
    // and the SDK is intentionally not a declared devDependency). For (b)
    // the user explicitly set OTEL_EXPORTER_OTLP_ENDPOINT and expects
    // tracing to work — silently no-oping leaves them with empty Jaeger
    // boards and no signal.
    //
    // Distinguish via the error code: ERR_MODULE_NOT_FOUND → silent;
    // anything else → one-shot stderr warning with the underlying reason.
    const code = /** @type {{ code?: string }} */ (err)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND") {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tracing] OTel setup failed; tracing disabled — ${message}\n`);
    }
    cached = noopTracer;
    return cached;
  }
}

/**
 * Synchronous tracer accessor. Returns the cached tracer if `getTracer` has
 * been awaited, else the no-op. Useful at call sites that can't be made async.
 *
 * @returns {Tracer}
 */
export function getTracerSyncOrNoop() {
  return cached ?? noopTracer;
}

/**
 * Test-only reset hook.
 */
export function _resetTracerForTests() {
  cached = null;
}
