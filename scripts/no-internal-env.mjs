#!/usr/bin/env node
/**
 * Pretest enforcement: assert that `lib/` does NOT read internal env
 * vars directly. Per the v2 plan for the AgentContext refactor, the
 * boundary builder (`lib/agent-context.mjs::buildAgentContextFromArgv`)
 * is the ONE place we read `ARTAGON_*` and `ACP_WIRE_LOG*`; lib code
 * reads from the `AgentContext` instead.
 *
 * This guard runs in CI to prevent regressions: if a future PR adds a
 * `process.env.ARTAGON_FOO` read to `lib/`, this script fails with a
 * line-numbered list of offenders.
 *
 * Allowlist:
 *   - lib/agent-context.mjs            (the boundary itself)
 *   - lib/cli/flags.mjs                (parser — typed strings only,
 *                                       no process.env access)
 *
 * The bin/ tree is intentionally NOT scanned: each bin is its own
 * boundary and is allowed to read the legacy env vars to construct an
 * `AgentContext`. lib/ code consumes the context, not env.
 *
 * Provider-auth env (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) and
 * host-set env (XDG_*, CLAUDE_PLUGIN_*, HOME, TMPDIR) are external
 * contracts, NOT internal config — they remain env-var-based and are
 * NOT flagged.
 *
 * Exit codes:
 *   0  no violations
 *   1  one or more lib/ files read an internal env var
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const LIB_ROOT = path.join(REPO_ROOT, "lib");

/**
 * Files in `lib/` allowed to read internal env keys. Keep this set
 * minimal; every addition is a load-bearing decision.
 */
const ALLOWLIST = new Set([path.join(LIB_ROOT, "agent-context.mjs")]);

/**
 * Regex matching internal env-var reads. Captures the variable name
 * for the error message. Matches:
 *   process.env.ARTAGON_FOO              ← property access
 *   process.env.ACP_WIRE_LOG_FOO
 *   env.ARTAGON_FOO   (where `env` is any identifier)
 *   env.ACP_WIRE_LOG
 *   env["ARTAGON_FOO"]                   ← bracket access
 *   env["ACP_WIRE_LOG"]
 *   const { ARTAGON_FOO } = process.env  ← destructuring (caught by the
 *                                          internal-keys alternation
 *                                          paired with `}` lookahead)
 *
 * The destructuring case matters because `const { ARTAGON_X } = process.env`
 * looks like a plain object-destructure to a syntactic regex, NOT like a
 * property access. An earlier version of this guard missed it; an
 * adversarial review caught the hole.
 */
const VIOLATION =
  /\b\w+\.env\.(ARTAGON_[A-Z_]+|ACP_WIRE_LOG[A-Z_]*)\b|\b\w+\.(ARTAGON_[A-Z_]+|ACP_WIRE_LOG[A-Z_]*)\b|\benv\[["'](ARTAGON_[A-Z_]+|ACP_WIRE_LOG[A-Z_]*)["']\]|\{[^}]*\b(ARTAGON_[A-Z_]+|ACP_WIRE_LOG[A-Z_]*)\b[^}]*\}\s*=\s*\w+\.env\b/g;

/** @type {{ file: string, line: number, content: string }[]} */
const violations = [];

/** @param {string} dir */
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    if (ALLOWLIST.has(full)) continue;
    checkFile(full);
  }
}

/** @param {string} file */
function checkFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines so docstrings can mention legacy env-var
    // names without tripping the guard.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // Reset regex lastIndex for global re-use.
    VIOLATION.lastIndex = 0;
    if (VIOLATION.test(line)) {
      violations.push({
        file: path.relative(REPO_ROOT, file),
        line: i + 1,
        content: line.trim()
      });
    }
  }
}

walk(LIB_ROOT);

if (violations.length === 0) {
  process.exit(0);
}

process.stderr.write(
  `[no-internal-env] FAIL — ${violations.length} internal env-var read(s) in lib/:\n\n`
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.content}\n\n`);
}
process.stderr.write(
  "Lib code must NOT read process.env.ARTAGON_* or process.env.ACP_WIRE_LOG* directly.\n" +
    "Read from the AgentContext instead (lib/agent-context.mjs). The boundary builder\n" +
    "buildAgentContextFromArgv translates env vars into the context; if you need a new\n" +
    "knob, add it to AgentContext and have the boundary populate it.\n"
);
process.exit(1);
