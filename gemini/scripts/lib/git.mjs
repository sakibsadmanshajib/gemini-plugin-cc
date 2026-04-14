/**
 * Git operations for collecting repository context used in code reviews.
 */

import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

/**
 * Ensure we are inside a git repository. Returns the repo root path.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function ensureGitRepository(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/**
 * Get the current branch name, or null if detached.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function getCurrentBranch(cwd) {
  const result = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch === "HEAD" ? null : branch;
}

/**
 * Get the short SHA of HEAD.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getHeadSha(cwd) {
  return gitChecked(cwd, ["rev-parse", "--short", "HEAD"]).trim();
}

/**
 * List files with changes in the working tree (staged + unstaged).
 *
 * @param {string} cwd
 * @returns {{ staged: string[], unstaged: string[], untracked: string[] }}
 */
export function getWorkingTreeFiles(cwd) {
  const statusOutput = gitChecked(cwd, ["status", "--porcelain", "-u"]);
  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (const line of statusOutput.split("\n")) {
    if (!line || line.length < 3) {
      continue;
    }
    const indexStatus = line[0];
    const workingStatus = line[1];
    const filePath = line.slice(3).trim();

    if (indexStatus === "?") {
      untracked.push(filePath);
    } else {
      if (indexStatus !== " " && indexStatus !== "?") {
        staged.push(filePath);
      }
      if (workingStatus !== " " && workingStatus !== "?") {
        unstaged.push(filePath);
      }
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * Get the unified diff for staged changes.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getStagedDiff(cwd) {
  return gitChecked(cwd, ["diff", "--cached"]);
}

/**
 * Get the unified diff for unstaged changes.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getUnstagedDiff(cwd) {
  return gitChecked(cwd, ["diff"]);
}

/**
 * Get the combined working-tree diff (staged + unstaged against HEAD).
 *
 * @param {string} cwd
 * @returns {string}
 */
export function getWorkingTreeDiff(cwd) {
  return gitChecked(cwd, ["diff", "HEAD"]);
}

/**
 * Read untracked file contents, up to a byte limit.
 *
 * @param {string} cwd
 * @param {string[]} files
 * @param {{ maxBytes?: number }} [options]
 * @returns {Array<{ path: string, content: string } | { path: string, skipped: string }>}
 */
export function readUntrackedFiles(cwd, files, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_UNTRACKED_BYTES;
  let totalBytes = 0;
  const results = [];

  for (const file of files) {
    const fullPath = path.join(cwd, file);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        results.push({ path: file, skipped: "not a regular file" });
        continue;
      }
      if (totalBytes + stat.size > maxBytes) {
        results.push({ path: file, skipped: `exceeds byte limit (${stat.size} bytes)` });
        continue;
      }
      const buffer = fs.readFileSync(fullPath);
      if (!isProbablyText(buffer)) {
        results.push({ path: file, skipped: "binary file" });
        continue;
      }
      const content = buffer.toString("utf8");
      totalBytes += Buffer.byteLength(content, "utf8");
      results.push({ path: file, content });
    } catch {
      results.push({ path: file, skipped: "read error" });
    }
  }

  return results;
}

/**
 * Collect complete working-tree context for a code review.
 *
 * @param {string} cwd
 * @param {{ maxInlineFiles?: number, maxInlineDiffBytes?: number }} [options]
 * @returns {{ branch: string | null, headSha: string, diff: string, files: { staged: string[], unstaged: string[], untracked: string[] }, untrackedContents: Array<any>, summary: string }}
 */
export function collectWorkingTreeContext(cwd, options = {}) {
  const branch = getCurrentBranch(cwd);
  const headSha = getHeadSha(cwd);
  const files = getWorkingTreeFiles(cwd);
  const diff = getWorkingTreeDiff(cwd);
  const untrackedContents = readUntrackedFiles(cwd, files.untracked);

  const allFiles = listUniqueFiles(files.staged, files.unstaged);
  const summary = buildWorkingTreeSummary(branch, headSha, allFiles, files.untracked);

  return { branch, headSha, diff, files, untrackedContents, summary };
}

/**
 * Build a human-readable summary of working-tree changes.
 *
 * @param {string | null} branch
 * @param {string} headSha
 * @param {string[]} changedFiles
 * @param {string[]} untrackedFiles
 * @returns {string}
 */
export function buildWorkingTreeSummary(branch, headSha, changedFiles, untrackedFiles) {
  const lines = [];
  lines.push(`Branch: ${branch ?? "detached HEAD"} (${headSha})`);
  lines.push(`Changed files: ${changedFiles.length}`);
  if (untrackedFiles.length > 0) {
    lines.push(`Untracked files: ${untrackedFiles.length}`);
  }
  if (changedFiles.length > 0) {
    lines.push("");
    lines.push("Files:");
    for (const f of changedFiles) {
      lines.push(`  ${f}`);
    }
  }
  if (untrackedFiles.length > 0) {
    lines.push("");
    lines.push("Untracked:");
    for (const f of untrackedFiles) {
      lines.push(`  ${f}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build a branch comparison for review (current branch vs base).
 *
 * @param {string} cwd
 * @param {string} baseRef
 * @returns {{ mergeBase: string, diff: string, commits: string, fileList: string[], summary: string }}
 */
export function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).trim();
  const diff = gitChecked(cwd, ["diff", `${mergeBase}...HEAD`]);
  const commits = gitChecked(cwd, ["log", "--oneline", `${mergeBase}...HEAD`]);
  const fileListRaw = gitChecked(cwd, ["diff", "--name-only", `${mergeBase}...HEAD`]);
  const fileList = fileListRaw.trim().split("\n").filter(Boolean);

  const summary = [
    `Comparing HEAD to ${baseRef} (merge-base: ${mergeBase.slice(0, 8)})`,
    `Changed files: ${fileList.length}`,
    `Commits: ${commits.trim().split("\n").length}`,
    "",
    "Files:",
    ...fileList.map((f) => `  ${f}`)
  ].join("\n");

  return { mergeBase, diff, commits, fileList, summary };
}

/**
 * Collect git context based on scope (working-tree or branch).
 *
 * @param {string} cwd
 * @param {{ scope?: "auto" | "working-tree" | "branch", base?: string }} [options]
 * @returns {{ scope: string, context: any }}
 */
export function collectReviewContext(cwd, options = {}) {
  const scope = options.scope ?? "auto";

  if (scope === "branch" && options.base) {
    return {
      scope: "branch",
      context: buildBranchComparison(cwd, options.base)
    };
  }

  if (scope === "auto") {
    // If there are working-tree changes, review those. Otherwise try branch.
    const files = getWorkingTreeFiles(cwd);
    const hasChanges = files.staged.length > 0 || files.unstaged.length > 0 || files.untracked.length > 0;
    if (hasChanges) {
      return {
        scope: "working-tree",
        context: collectWorkingTreeContext(cwd)
      };
    }
    // Try branch comparison against main/master.
    for (const base of ["main", "master"]) {
      const result = git(cwd, ["rev-parse", "--verify", base]);
      if (result.status === 0) {
        return {
          scope: "branch",
          context: buildBranchComparison(cwd, base)
        };
      }
    }
  }

  // Default to working-tree.
  return {
    scope: "working-tree",
    context: collectWorkingTreeContext(cwd)
  };
}
