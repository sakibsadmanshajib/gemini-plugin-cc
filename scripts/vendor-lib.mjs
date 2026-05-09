#!/usr/bin/env node

// Sync repo-root `lib/` into each plugin's `lib/` so the marketplace
// install ships a self-contained plugin tree. Plugin scripts use
// `#lib/*` (resolved via `plugins/<host>/package.json` imports map) and
// the marketplace install copies files but does not run npm install or
// follow symlinks — vendoring is the only path that survives.
//
// All three host plugins (claude, codex, gemini) carry an identical
// vendored copy. They diverge only in their own scripts/, commands/,
// and per-host metadata.
//
// Modes:
//   pnpm vendor:lib          → copy repo-root lib/ into plugins/<host>/lib/
//                              for every host
//   pnpm vendor:lib:check    → fail with a non-zero exit if any of the
//                              three vendored copies differ from
//                              repo-root in CONTENT. CI runs this in
//                              the test workflow as a drift firewall.
//                              We use `diff -rq` (content, not
//                              timestamps) because timestamps drift
//                              naturally on every checkout and aren't a
//                              meaningful signal.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "lib");
const HOSTS = ["claude", "codex", "gemini"];
const DSTS = HOSTS.map((host) => ({
  host,
  path: path.join(REPO_ROOT, "plugins", host, "lib")
}));

const mode = process.argv[2] === "--check" ? "check" : "sync";

if (mode === "check") {
  // `diff -rq` reports per-file content differences and missing files.
  // Exit 0 = identical, 1 = differs, 2 = error. We surface the diff
  // output verbatim so CI logs name the offending files.
  let allInSync = true;
  for (const { host, path: dst } of DSTS) {
    const result = spawnSync("diff", ["-rq", SRC, dst], { encoding: "utf8" });
    if (result.status === 0) continue;
    allInSync = false;
    process.stderr.write(`[vendor:lib] DRIFT: plugins/${host}/lib/ does not match lib/.\n`);
    if (result.stdout) {
      process.stderr.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
  if (!allInSync) {
    process.stderr.write("[vendor:lib] Run `pnpm vendor:lib` to re-sync.\n");
    process.exit(1);
  }
  process.stdout.write("[vendor:lib] all three plugin lib/ trees in sync.\n");
  process.exit(0);
}

for (const { host, path: dst } of DSTS) {
  execFileSync("rsync", ["-rL", "--delete", `${SRC}/`, `${dst}/`], {
    stdio: "inherit"
  });
  process.stdout.write(`[vendor:lib] synced lib/ → plugins/${host}/lib/\n`);
}
