/**
 * File-system helpers shared across the Gemini companion scripts.
 */

import fs from "node:fs";

/**
 * Read and parse a JSON file. Returns `null` if the file does not exist or
 * cannot be parsed.
 *
 * @param {string} filePath
 * @returns {any}
 */
export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Heuristic check: is a buffer likely UTF-8 text (as opposed to binary)?
 * Returns `false` for buffers containing NULL bytes in the first 8 KB.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isProbablyText(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Safely read a text file. Returns an empty string on failure.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
