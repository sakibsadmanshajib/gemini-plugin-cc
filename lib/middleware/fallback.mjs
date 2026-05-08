/**
 * Fallback middleware — on permanent error or model-overload, retry the
 * same request with a different model from a configured fallback chain.
 *
 * Position: after retry. Retry handles transient blips; fallback handles
 * "this model can't serve right now or at all." Trigger conditions:
 *   - permanent errors that retry classifies as not-retryable
 *     EXCEPT auth-required (no model swap helps) and aborted
 *   - 503 / model-overloaded responses
 *
 * The fallback chain is supplied per-call via params.model (the original
 * request) — the middleware uses params._fallbackModels (an internal
 * convention) to know what to try next. Backends that want fallback
 * inject `_fallbackModels: ["sonnet", "haiku"]` into the prompt params.
 *
 * If params don't include the convention, the middleware is a no-op —
 * passes the original request through unchanged.
 */

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 *
 * @typedef {{
 *   onFallback?: (info: { from: string, to: string, reason: string }) => void
 * }} FallbackConfig
 */

const FALLBACK_TRIGGER_RE = /\b(model.*overload|overload|capacity|503|service unavailable)\b/i;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function shouldFallback(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ kind?: string, message?: string }} */ (err);
  if (e.kind === "auth-required" || e.kind === "aborted" || e.kind === "validation") {
    return false;
  }
  if (typeof e.message === "string" && FALLBACK_TRIGGER_RE.test(e.message)) {
    return true;
  }
  // Otherwise: only fallback on internal errors (model misbehaving).
  return e.kind === "internal";
}

/**
 * @param {FallbackConfig} [userConfig]
 * @returns {Middleware}
 */
export function createFallbackMiddleware(userConfig = {}) {
  const onFallback = userConfig.onFallback;

  return {
    name: "fallback",
    wrap(next) {
      return {
        start: () => next.start(),
        async request(method, params) {
          // Only intervene on prompt-shaped requests with the fallback convention.
          const p = /** @type {any} */ (params);
          const fallbacks = Array.isArray(p?._fallbackModels) ? [...p._fallbackModels] : [];
          if (fallbacks.length === 0 || method !== "session/prompt") {
            return next.request(method, params);
          }

          // First attempt: original model.
          try {
            return await next.request(method, params);
          } catch (err) {
            if (!shouldFallback(err)) throw err;

            let lastErr = err;
            const originalModel = p.model ?? "(default)";
            for (const model of fallbacks) {
              const fallbackParams = { ...p, model };
              const reason = err instanceof Error ? err.message : String(err);
              onFallback?.({ from: String(originalModel), to: model, reason });
              try {
                return await next.request(method, fallbackParams);
              } catch (e) {
                lastErr = e;
                if (!shouldFallback(e)) throw e;
              }
            }
            // Exhausted chain.
            throw lastErr;
          }
        },
        notify: (method, params) => next.notify(method, params),
        onNotification: (handler) => next.onNotification(handler),
        onHealthChange: (handler) => next.onHealthChange(handler),
        healthState: () => next.healthState(),
        close: () => next.close(),
        isOpen: () => next.isOpen()
      };
    }
  };
}
