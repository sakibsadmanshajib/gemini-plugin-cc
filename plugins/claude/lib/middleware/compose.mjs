/**
 * Middleware composition.
 *
 * A middleware is `(next: AcpSession) => AcpSession`. It wraps an inner
 * session, intercepting any subset of methods it cares about and delegating
 * the rest. `composeMiddleware([m1, m2, m3])(session)` produces a chain
 * where m1 is outermost (sees calls first, sees responses last) and the
 * raw `session` is innermost.
 *
 * Order matters. Redaction MUST be at index 0 — every other middleware
 * (audit, cost, observability) sees only post-redaction content. The
 * compose helper validates this at construction time.
 */

/**
 * @typedef {import("../acp/types.mjs").AcpSession} AcpSession
 *
 * @typedef {{ name?: string, wrap: (next: AcpSession) => AcpSession }} Middleware
 */

export class MiddlewareOrderError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MiddlewareOrderError";
  }
}

/**
 * Compose an ordered list of middlewares into a single AcpSession-wrapping
 * function. Outermost first.
 *
 * Validates the redaction-first invariant: if any middleware named
 * "redaction" appears, it MUST be at index 0. Throws `MiddlewareOrderError`
 * in development; emits a stderr warning in production (NODE_ENV === "production").
 *
 * @param {Middleware[]} middlewares
 * @returns {(session: AcpSession) => AcpSession}
 */
export function composeMiddleware(middlewares) {
  validateOrder(middlewares);

  return (session) => {
    let wrapped = session;
    // Apply right-to-left so the leftmost middleware ends up outermost.
    for (let i = middlewares.length - 1; i >= 0; i--) {
      wrapped = middlewares[i].wrap(wrapped);
    }
    return wrapped;
  };
}

/**
 * @param {Middleware[]} middlewares
 */
function validateOrder(middlewares) {
  if (!Array.isArray(middlewares)) {
    throw new MiddlewareOrderError("composeMiddleware: input must be an array");
  }
  for (const m of middlewares) {
    if (!m || typeof m.wrap !== "function") {
      throw new MiddlewareOrderError(
        "composeMiddleware: every middleware must have a wrap() function"
      );
    }
  }
  const redactionIndex = middlewares.findIndex((m) => m.name === "redaction");
  if (redactionIndex > 0) {
    // Always fail fast — including in production. The redaction-first
    // invariant is a security property: with redaction at index N>0, every
    // middleware between 0 and N (audit, observability, cost) sees raw
    // request/response payloads with un-redacted secrets and PII. The
    // previous "warn but continue in production" behavior was backwards:
    // it failed-open in exactly the deployment where the consequence
    // (real user data leaking via audit logs) is most severe.
    //
    // Middleware composition happens once at app startup, never with
    // user-controlled input — a wrong order is a programming bug, not a
    // runtime condition we should tolerate.
    throw new MiddlewareOrderError(
      "composeMiddleware: redaction middleware MUST be at index 0 " +
        `(found at index ${redactionIndex}). Other middlewares would see ` +
        "un-redacted content, violating the redaction-first invariant."
    );
  }
}

/**
 * Identity middleware — pass-through wrapper. Useful as a smoke test for
 * the composition machinery and as a base when subclassing one method.
 *
 * @type {Middleware}
 */
export const identityMiddleware = {
  name: "identity",
  wrap(next) {
    return next;
  }
};
