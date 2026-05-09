/**
 * Backend name enum — single source of truth for the string literals
 * naming the three backends. Use members of `BACKEND_NAMES` instead of
 * the bare strings `"claude"` / `"codex"` / `"gemini"` so a typo gets
 * caught at typecheck time and the set of valid names lives in one
 * place.
 *
 * JS doesn't have native enums; the project's convention is a frozen
 * object exported alongside a typedef that narrows to the union of its
 * value types. This is the same pattern used elsewhere (see e.g. the
 * VERDICT const in `plugins/gemini/scripts/lib/review-gate-verdict.mjs`).
 */

/**
 * @typedef {"claude" | "codex" | "gemini"} BackendName
 */

/** @type {Readonly<{ CLAUDE: BackendName, CODEX: BackendName, GEMINI: BackendName }>} */
export const BACKEND_NAMES = Object.freeze({
  CLAUDE: /** @type {BackendName} */ ("claude"),
  CODEX: /** @type {BackendName} */ ("codex"),
  GEMINI: /** @type {BackendName} */ ("gemini")
});

/**
 * Ordered list of all backend names. Useful for iteration:
 * `for (const name of ALL_BACKEND_NAMES) { ... }`.
 *
 * @type {readonly BackendName[]}
 */
export const ALL_BACKEND_NAMES = Object.freeze([
  BACKEND_NAMES.CLAUDE,
  BACKEND_NAMES.CODEX,
  BACKEND_NAMES.GEMINI
]);

/**
 * Type guard: is `value` one of the known backend names?
 *
 * @param {unknown} value
 * @returns {value is BackendName}
 */
export function isBackendName(value) {
  return (
    value === BACKEND_NAMES.CLAUDE ||
    value === BACKEND_NAMES.CODEX ||
    value === BACKEND_NAMES.GEMINI
  );
}
