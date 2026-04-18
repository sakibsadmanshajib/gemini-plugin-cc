/**
 * Thinking t-shirt sizing resolver.
 *
 * Maps a categorical level (off/low/medium/high) to the concrete
 * thinking configuration the current Gemini CLI expects, given the
 * target model family.
 *
 * Gemini 3 models use `thinkingLevel` ("low" | "high").
 * Gemini 2.5 models use `thinkingBudget` (numeric; -1 = dynamic, 0 = off).
 */

export const THINKING_LEVELS = ["off", "low", "medium", "high"];

const LEVEL_SET = new Set(THINKING_LEVELS);

/**
 * @typedef {Object} ThinkingConfig
 * @property {"low"|"high"|undefined} thinkingLevel
 * @property {number|undefined} thinkingBudget
 * @property {string[]} notes
 */

function detectFamily(modelId) {
  if (!modelId || typeof modelId !== "string") return "unknown";
  if (/^gemini-3(\.|-|$)/.test(modelId) || /^auto-gemini-3/.test(modelId)) return "gemini-3";
  if (/^gemini-2\.5-flash-lite/.test(modelId)) return "gemini-2.5-flash-lite";
  if (/^gemini-2\.5-flash/.test(modelId)) return "gemini-2.5-flash";
  if (/^gemini-2\.5-pro/.test(modelId) || /^auto-gemini-2\.5/.test(modelId)) return "gemini-2.5-pro";
  return "unknown";
}

/**
 * @param {string|undefined} level
 * @param {string|null|undefined} modelId
 * @returns {ThinkingConfig}
 */
export function resolveThinkingConfig(level, modelId) {
  if (level === undefined) {
    return { thinkingLevel: undefined, thinkingBudget: undefined, notes: [] };
  }
  if (!LEVEL_SET.has(level)) {
    throw new Error(`Invalid thinking level: ${level}. Expected one of ${THINKING_LEVELS.join(", ")}.`);
  }

  const family = detectFamily(modelId);
  const notes = [];

  if (family === "unknown") {
    notes.push("unknown model family; thinking config not delivered");
    return { thinkingLevel: undefined, thinkingBudget: undefined, notes };
  }

  if (family === "gemini-3") {
    if (level === "off") {
      notes.push("clamped off→low: Gemini 3 does not support zero thinking");
      return { thinkingLevel: "low", thinkingBudget: undefined, notes };
    }
    if (level === "low") return { thinkingLevel: "low", thinkingBudget: undefined, notes };
    if (level === "medium") {
      notes.push("gemini-3 medium uses model default dynamic thinking");
      return { thinkingLevel: undefined, thinkingBudget: undefined, notes };
    }
    if (level === "high") return { thinkingLevel: "high", thinkingBudget: undefined, notes };
  }

  if (family === "gemini-2.5-pro") {
    if (level === "off") {
      notes.push("clamped off→low: Gemini 2.5 Pro does not support disabling thinking; using thinkingBudget 2048 (API minimum is 128)");
      return { thinkingLevel: undefined, thinkingBudget: 2048, notes };
    }
    if (level === "low") return { thinkingLevel: undefined, thinkingBudget: 2048, notes };
    if (level === "medium") return { thinkingLevel: undefined, thinkingBudget: -1, notes };
    if (level === "high") return { thinkingLevel: undefined, thinkingBudget: 24576, notes };
  }

  if (family === "gemini-2.5-flash" || family === "gemini-2.5-flash-lite") {
    if (level === "off") return { thinkingLevel: undefined, thinkingBudget: 0, notes };
    if (level === "low") return { thinkingLevel: undefined, thinkingBudget: 2048, notes };
    if (level === "medium") return { thinkingLevel: undefined, thinkingBudget: -1, notes };
    if (level === "high") return { thinkingLevel: undefined, thinkingBudget: 24576, notes };
  }

  throw new Error(`unreachable: unhandled thinking level/family combination (${level}, ${family})`);
}
