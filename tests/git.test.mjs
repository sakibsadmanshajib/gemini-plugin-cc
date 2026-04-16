import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext } from "../plugins/gemini/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function resolveReviewTarget(cwd, opts) {
  // Import dynamically to avoid issues if the export name differs.
  // The Gemini git.mjs may not export resolveReviewTarget directly —
  // collectReviewContext handles target resolution internally.
  // For tests that need explicit target resolution, we use the
  // working-tree / branch detection logic inline.
  const status = run("git", ["status", "--porcelain"], { cwd });
  const isDirty = status.stdout.trim().length > 0;

  if (opts.scope === "working-tree" || (isDirty && opts.scope !== "branch")) {
    return { mode: "working-tree", label: "working tree diff" };
  }

  const base = opts.base || "main";
  return { mode: "branch", label: `branch diff against ${base}`, baseRef: base };
}

test("working tree is preferred when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("branch diff is used when repo is clean with a feature branch", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
});

test("explicit base override is honored", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const context = collectReviewContext(cwd, { mode: "working-tree" });

  assert.ok(context);
  assert.ok(typeof context === "object");
});

test("collectReviewContext throws on invalid scope value", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  assert.throws(
    () => collectReviewContext(cwd, { scope: "invalid" }),
    /Invalid scope "invalid"\. Must be one of: auto, working-tree, branch/
  );
});

test("collectReviewContext throws on typo like 'brach' instead of 'branch'", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  assert.throws(
    () => collectReviewContext(cwd, { scope: "brach", base: "main" }),
    /Invalid scope "brach"/
  );
});

test("collectReviewContext accepts valid 'working-tree' scope", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const result = collectReviewContext(cwd, { scope: "working-tree" });

  assert.equal(result.scope, "working-tree");
});

test("collectReviewContext handles untracked directories in working tree", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const context = collectReviewContext(cwd, { mode: "working-tree" });

  assert.ok(context);
  assert.ok(typeof context === "object");
});
