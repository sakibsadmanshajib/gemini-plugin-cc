/**
 * Wire contract for the stop-review-gate verdict format.
 *
 * The prompt template at `plugins/gemini/prompts/stop-review-gate.md`
 * instructs Gemini to emit a single first line of either:
 *
 *   ALLOW: <short reason>
 *   BLOCK: <short reason>
 *
 * This module is the single source of truth for those tokens — the prompt
 * template, the parsing code in `stop-review-gate-hook.mjs`, and any tests
 * that pin the verdict format must reference these constants instead of
 * scattering raw "ALLOW:" / "BLOCK:" strings across the codebase.
 *
 * The trailing colon is part of the token (the prompt template requires it).
 * Do not add whitespace handling here — `firstLine.startsWith(VERDICT.ALLOW)`
 * is the canonical check; whitespace tolerance belongs at the parser.
 */

export const VERDICT = Object.freeze({
  ALLOW: "ALLOW:",
  BLOCK: "BLOCK:"
});

/**
 * The set of all verdict prefix tokens, useful for testing that a line
 * starts with ANY known verdict.
 *
 * @type {ReadonlyArray<string>}
 */
export const VERDICT_PREFIXES = Object.freeze(Object.values(VERDICT));

/**
 * Parse a Gemini response's first line into a structured verdict.
 *
 * @param {string} firstLine - The first line of Gemini's stdout.
 * @returns {{ kind: "allow" | "block" | "unknown", reason: string }}
 */
export function parseVerdict(firstLine) {
  const line = firstLine ?? "";
  if (line.startsWith(VERDICT.ALLOW)) {
    return { kind: "allow", reason: line };
  }
  if (line.startsWith(VERDICT.BLOCK)) {
    return { kind: "block", reason: line };
  }
  return { kind: "unknown", reason: line };
}
