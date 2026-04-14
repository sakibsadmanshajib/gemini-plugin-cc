/**
 * Workspace root resolution.
 */

import { ensureGitRepository } from "./git.mjs";

/**
 * Resolve the workspace root directory. Falls back to `cwd` if not inside a
 * git repository.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
