/**
 * Prompt template loading and variable interpolation.
 */

import fs from "node:fs";
import path from "node:path";

const PROMPTS_DIR = path.resolve(new URL("../../prompts", import.meta.url).pathname);

/**
 * Load a prompt template by name and interpolate variables.
 *
 * @param {string} templateName - Filename without extension (e.g., "adversarial-review")
 * @param {Record<string, string>} variables - Map of `{{KEY}}` -> replacement value
 * @returns {string}
 */
export function loadPrompt(templateName, variables = {}) {
  const filePath = path.join(PROMPTS_DIR, `${templateName}.md`);
  let content = fs.readFileSync(filePath, "utf8");

  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  return content;
}

/**
 * Load a prompt template from an absolute path and interpolate variables.
 *
 * @param {string} filePath
 * @param {Record<string, string>} variables
 * @returns {string}
 */
export function loadPromptFile(filePath, variables = {}) {
  let content = fs.readFileSync(filePath, "utf8");

  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  return content;
}
