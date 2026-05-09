#!/usr/bin/env node

// Sync repo-root `lib/` into `plugins/gemini/lib/` so the marketplace
// install ships a self-contained plugin tree. The plugin's scripts use
// `#lib/*` (resolved via `plugins/gemini/package.json` imports map) and
// the marketplace install copies files but does not run npm install or
// follow symlinks — vendoring is the only path that survives.
//
// Modes:
//   pnpm vendor:lib          → copy repo-root lib/ into plugins/gemini/lib/
//   pnpm vendor:lib:check    → fail with a non-zero exit if the two
//                              directories differ in CONTENT. CI runs
//                              this in the test workflow as a drift
//                              firewall. We use `diff -rq` (content,
//                              not timestamps) because timestamps drift
//                              naturally on every checkout and aren't a
//                              meaningful signal.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "lib");
const DST = path.join(REPO_ROOT, "plugins", "gemini", "lib");

const mode = process.argv[2] === "--check" ? "check" : "sync";

if (mode === "check") {
  // `diff -rq` reports per-file content differences and missing files.
  // Exit 0 = identical, 1 = differs, 2 = error. We surface the diff
  // output verbatim so CI logs name the offending files.
  const result = spawnSync("diff", ["-rq", SRC, DST], { encoding: "utf8" });
  if (result.status === 0) {
    process.stdout.write("[vendor:lib] in sync.\n");
    process.exit(0);
  }
  process.stderr.write("[vendor:lib] DRIFT: plugins/gemini/lib/ does not match lib/.\n");
  process.stderr.write("[vendor:lib] Run `pnpm vendor:lib` to re-sync.\n");
  if (result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(1);
}

execFileSync("rsync", ["-rL", "--delete", `${SRC}/`, `${DST}/`], {
  stdio: "inherit"
});
process.stdout.write("[vendor:lib] synced lib/ → plugins/gemini/lib/\n");
