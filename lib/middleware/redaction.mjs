/**
 * Redaction middleware — replaces secret patterns in inbound and outbound
 * payloads with a `[redacted]` placeholder.
 *
 * Position invariant: this middleware MUST be at index 0 of every
 * composed chain (`composeMiddleware` validates). Audit, cost, observability,
 * and any logging that fires downstream see only post-redaction content.
 *
 * Default patterns cover:
 *   - OpenAI / Anthropic / Google API key shapes (sk-..., ant-..., AIza...)
 *   - Bearer tokens in Authorization headers
 *   - PEM private key blocks
 *   - URLs with embedded basic-auth credentials
 *   - Generic field-level redaction for known credential field names
 *
 * Additional patterns can be supplied at construction time. Property tests
 * verify the invariants:
 *   - "any text containing a known secret pattern produces text without
 *     that secret after redaction" — `tests/unit/middleware.test.mjs`
 *     "property: redaction never lets known secret patterns through"
 *   - "field-level redaction never leaks the value of a known credential
 *     field name at any nesting depth" —
 *     `tests/property/redaction-field-level.test.mjs`
 */

const DEFAULT_PATTERNS = [
  // OpenAI keys: sk-... (legacy) and sk-proj-...
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Anthropic API keys: sk-ant-... (most current) and ant-...
  /\bant-[A-Za-z0-9_-]{20,}/g,
  // Google API keys: AIza...
  /AIza[A-Za-z0-9_-]{35,}/g,
  // Bearer tokens in Authorization headers
  /(authorization\s*[:=]\s*)bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // URLs with embedded credentials: https://user:pass@host
  /(https?:\/\/)([^/@\s:]+):([^/@\s]+)@/g
];

// The credential field-name set MUST stay in sync with the project's two
// other independent redaction layers — `lib/wire-log.mjs` REDACT_TOKENS
// (regex-based scrubbing of serialized JSON wire frames) and
// `lib/logger.mjs` REDACTED_PATHS (pino redact paths for structured logs).
// This middleware is the PRIMARY layer (applied at session entry, before
// any other middleware sees the payload); the other two are defense-in-
// depth nets for payloads that bypass this layer. A name missing from
// any of the three opens a leak window for payloads that bypass that
// layer.
const DEFAULT_FIELD_NAMES = [
  "api_key",
  "apiKey",
  "authorization",
  "Authorization",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret"
];

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 * @typedef {{
 *   patterns?: RegExp[],
 *   fieldNames?: string[],
 *   replacement?: string
 * }} RedactionConfig
 */

/**
 * Recursively redact secrets from any JSON-shaped value. Strings get pattern
 * substitution; objects get field-level replacement on known credential field
 * names; arrays and nested objects recurse. Other values pass through.
 *
 * Pure function — does not mutate the input.
 *
 * @param {unknown} value
 * @param {{ patterns: RegExp[], fieldNames: Set<string>, replacement: string }} config
 * @returns {unknown}
 */
export function redactValue(value, config) {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of config.patterns) {
      // Reset lastIndex defensively (g flag has stateful regex).
      pattern.lastIndex = 0;
      out = out.replace(pattern, (_match, ...groups) => {
        // For URL-credentials pattern, preserve the protocol+host shape so
        // the redaction doesn't destroy URLs entirely.
        if (groups.length >= 3 && typeof groups[0] === "string" && groups[0].startsWith("http")) {
          return `${groups[0]}[redacted]:[redacted]@`;
        }
        // For Authorization-bearer pattern, preserve the field-name prefix.
        if (
          groups.length >= 1 &&
          typeof groups[0] === "string" &&
          /authorization/i.test(groups[0])
        ) {
          return `${groups[0]}${config.replacement}`;
        }
        return config.replacement;
      });
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, config));
  }
  if (value && typeof value === "object") {
    // Use Object.fromEntries instead of `out[key] = ...` so that special
    // names like `__proto__` (which can show up as own-properties when an
    // object is built via JSON.parse) round-trip as own-properties rather
    // than being silently swallowed by the [[Prototype]] setter. Without
    // this, an input like `JSON.parse('{"__proto__":"x"}')` would produce
    // an output `{}` (data loss for the field, even though the credential
    // never reaches the wire). fromEntries always creates own-properties.
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        config.fieldNames.has(key) && typeof v === "string" && v.length > 0
          ? config.replacement
          : redactValue(v, config)
      ])
    );
  }
  return value;
}

/**
 * Build a redaction middleware. Wraps an AcpSession to redact `request`
 * params before delegation and `notification` params on inbound delivery.
 *
 * @param {RedactionConfig} [userConfig]
 * @returns {Middleware}
 */
export function createRedactionMiddleware(userConfig = {}) {
  const config = {
    patterns: [...DEFAULT_PATTERNS, ...(userConfig.patterns ?? [])],
    fieldNames: new Set([...DEFAULT_FIELD_NAMES, ...(userConfig.fieldNames ?? [])]),
    replacement: userConfig.replacement ?? "[redacted]"
  };

  return {
    name: "redaction",
    wrap(next) {
      return {
        start: () => next.start(),
        request: (method, params) => {
          const redacted = /** @type {object | undefined} */ (redactValue(params, config));
          return next.request(method, redacted);
        },
        notify: (method, params) => {
          const redacted = /** @type {object | undefined} */ (redactValue(params, config));
          next.notify(method, redacted);
        },
        onNotification: (handler) => {
          return next.onNotification((notification) => {
            const redactedParams = /** @type {object | undefined} */ (
              redactValue(notification.params, config)
            );
            handler({ ...notification, params: redactedParams });
          });
        },
        onHealthChange: (handler) => next.onHealthChange(handler),
        healthState: () => next.healthState(),
        close: () => next.close(),
        isOpen: () => next.isOpen()
      };
    }
  };
}
