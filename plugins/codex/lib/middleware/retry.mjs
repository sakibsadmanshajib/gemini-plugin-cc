/**
 * Retry middleware — exponential backoff on transient ACP errors.
 *
 * Retries on `kind: "rate-limited"` and `kind: "network"`. NEVER retries on
 * `auth-required`, `internal`, or `aborted` (those are permanent and
 * fast-fail is correct). Default: 3 attempts, 1s/2s/4s backoff.
 *
 * Errors thrown by `next.request()` are inspected by:
 *   - `error.code` (numeric JSON-RPC code) — `-32000` family is server-side
 *   - `error.kind` (string tag, if backend supplies one)
 *   - `error.message` (substring match for "rate limit"/"timeout"/"network")
 *
 * The classifier is deliberately fuzzy — backends use different error
 * shapes and we don't want a single backend's idiosyncrasy blocking retry
 * for the rest. Better to over-retry than to under-retry transient blips.
 */

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 *
 * @typedef {{
 *   maxAttempts?: number,
 *   initialBackoffMs?: number,
 *   maxBackoffMs?: number,
 *   classifyError?: (err: unknown) => "transient" | "permanent",
 *   onAttempt?: (info: { attempt: number, method: string, reason: string }) => void
 * }} RetryConfig
 */

const TRANSIENT_KIND_TAGS = new Set(["rate-limited", "network", "timeout", "transient"]);
const TRANSIENT_MESSAGE_RE =
  /\b(rate limit|429|timeout|timed out|econnreset|enetunreach|service unavailable|503|502|gateway timeout|network)\b/i;
const PERMANENT_KIND_TAGS = new Set(["auth-required", "internal", "aborted", "validation"]);

/**
 * @param {unknown} err
 * @returns {"transient" | "permanent"}
 */
export function defaultClassify(err) {
  if (!err || typeof err !== "object") return "permanent";
  const e = /** @type {{ kind?: string, code?: number, message?: string }} */ (err);
  if (e.kind && PERMANENT_KIND_TAGS.has(e.kind)) return "permanent";
  if (e.kind && TRANSIENT_KIND_TAGS.has(e.kind)) return "transient";
  if (typeof e.message === "string" && TRANSIENT_MESSAGE_RE.test(e.message)) return "transient";
  // -32000 family is server-side; some are transient, some not. Conservative
  // default: do not retry. Backends that want retry on a specific code
  // should map it to `kind: "transient"` in their error envelope.
  return "permanent";
}

/**
 * @param {RetryConfig} [userConfig]
 * @returns {Middleware}
 */
export function createRetryMiddleware(userConfig = {}) {
  const maxAttempts = userConfig.maxAttempts ?? 3;
  const initialBackoffMs = userConfig.initialBackoffMs ?? 1000;
  const maxBackoffMs = userConfig.maxBackoffMs ?? 16000;
  const classify = userConfig.classifyError ?? defaultClassify;
  const onAttempt = userConfig.onAttempt;

  return {
    name: "retry",
    wrap(next) {
      return {
        start: () => next.start(),
        async request(method, params) {
          let lastErr;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              return await next.request(method, params);
            } catch (err) {
              lastErr = err;
              if (classify(err) === "permanent" || attempt === maxAttempts) {
                throw err;
              }
              const message = err instanceof Error ? err.message : String(err);
              onAttempt?.({ attempt, method, reason: message });
              const backoff = Math.min(maxBackoffMs, initialBackoffMs * 2 ** (attempt - 1));
              await new Promise((r) => setTimeout(r, backoff));
            }
          }
          // Exhausted attempts without resolving; throw the last error so
          // upstream observers see the underlying cause, not a synthetic one.
          throw lastErr;
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
