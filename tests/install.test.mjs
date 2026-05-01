/**
 * Plugin install integration tests — verifies the plugin works under both
 * Claude Code and Codex CLI from the same source tree.
 *
 * Cross-platform: works on macOS (BSD `find`/`stat`) and Linux (GNU
 * userland). All path handling goes through `node:path` and `node:os`;
 * we don't shell out to platform-specific tools.
 *
 * What these tests prove (the actual install contract):
 *   1. The plugin's metadata files exist and parse on both schemas
 *      (Claude Code's `.claude-plugin/plugin.json` AND Codex's
 *      root `SKILL.md` + `agents/openai.yaml`).
 *   2. The runtime (`gemini-companion.mjs setup --json`) succeeds
 *      under both env shapes — Claude (host signal env vars set) and
 *      Codex (host signal env vars unset).
 *   3. State paths resolved by the runtime under each env shape
 *      do NOT collide. Each host gets its own state tree.
 *   4. The plugin's source tree contains all the files Codex's plugin
 *      manager needs to install it from a marketplace.json entry pointing
 *      at the plugin source dir. Codex copies the source into
 *      `~/.codex/plugins/cache/<MARKETPLACE>/<PLUGIN>/<VERSION>/` at install
 *      time. Plugins are NOT installed via `~/.agents/skills/` symlinks —
 *      that pattern is for standalone skills, not plugins.
 *
 * Cross-platform notes:
 *   - `os.tmpdir()` returns `/var/folders/...` on macOS and `/tmp` on
 *     Linux. We rely on this for the Codex-shape state root.
 *   - `os.homedir()` returns the platform-correct home dir.
 *   - We never assume specific paths; everything is computed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  PLUGIN_ROOT,
  PLUGIN_SOURCE_DIR_RELATIVE,
  CODEX_PLUGIN_DIR_NAME,
  CLAUDE_PLUGIN_DIR_NAME,
  PLUGIN_MANIFEST_FILENAME,
  MARKETPLACE_MANIFEST_FILENAME,
  AGENTS_DIR_NAME,
  OPENAI_AGENT_FILENAME,
  SKILL_MANIFEST_FILENAME,
  RUNTIME_SCRIPT_RELATIVE,
  BROKER_SCRIPT_RELATIVE,
  HOOKS_FILE_RELATIVE,
  CLAUDE_HOST_SIGNAL_ENV,
  CLAUDE_PLUGIN_DATA_ENV,
  SESSION_ID_ENV,
  SESSION_ENV_FILENAME,
  STATE_DIR_NAME,
  FALLBACK_STATE_ROOT_NAME,
  TEMP_PREFIX_CLAUDE_ENV,
  TEMP_PREFIX_WORKSPACE,
  TEMP_PREFIX_PLUGIN_DATA,
  TEMP_PREFIX_REALPATH,
  TEMP_PREFIX_SYMPARENT,
  pluginSourcePath,
  manifestPath
} from "./install-paths.mjs";

const RUNTIME = path.join(PLUGIN_ROOT, PLUGIN_SOURCE_DIR_RELATIVE, RUNTIME_SCRIPT_RELATIVE);
const STATE_LIB_PATH = path.join(PLUGIN_ROOT, PLUGIN_SOURCE_DIR_RELATIVE, "scripts", "lib", "state.mjs");
const SESSION_ENV_PLACEHOLDER = "# Claude session env\n";

function runNode(args, options = {}) {
  return spawnSync("node", [RUNTIME, ...args], {
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: 30_000,
    windowsHide: true
  });
}

function withEnv(overrides, fn) {
  const previous = {};
  const keys = Object.keys(overrides);
  for (const k of keys) {
    previous[k] = process.env[k];
    if (overrides[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = overrides[k];
    }
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = previous[k];
      }
    }
  }
}

// ─── 1. Metadata-file presence and parseability ────────────────────────────

test("install: root SKILL.md exists with valid frontmatter", () => {
  const skillMd = path.join(PLUGIN_ROOT, SKILL_MANIFEST_FILENAME);
  assert.ok(fs.existsSync(skillMd), `${SKILL_MANIFEST_FILENAME} must exist at plugin root: ${skillMd}`);

  const content = fs.readFileSync(skillMd, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${SKILL_MANIFEST_FILENAME} must start with a YAML frontmatter block fenced by ---`);

  const fm = match[1];
  // Required fields per agentskills.io spec
  assert.match(fm, /^name:\s+\S/m, "frontmatter must have a non-empty 'name' field");
  assert.match(fm, /^description:\s+\S/m, "frontmatter must have a non-empty 'description' field");

  const descMatch = fm.match(/^description:\s+(.+?)$/m);
  assert.ok(descMatch, "must extract description");
  const desc = descMatch[1];
  assert.ok(desc.length <= 1024, `description must be ≤ 1024 chars (got ${desc.length})`);

  // The skill name must reflect that this is a Gemini plugin (not arbitrary).
  // We match permissively — any name containing "gemini" is acceptable; tests
  // don't pin the exact string.
  const nameMatch = fm.match(/^name:\s+(\S+)/m);
  assert.match(nameMatch[1], /gemini/i, `skill name must reference Gemini; got '${nameMatch[1]}'`);
});

test(`install: canonical Codex ${CODEX_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} exists and parses`, () => {
  // OpenAI's documented Codex plugin path is .codex-plugin/plugin.json.
  // Codex tolerates .claude-plugin/ for backwards-compat with Claude-Code-only
  // plugins, but new plugins should ship the canonical path. Both must exist
  // and be byte-identical so neither host sees a stale name/version.
  const codexManifest = manifestPath("codex");
  const claudeManifest = manifestPath("claude");

  assert.ok(fs.existsSync(codexManifest), `canonical Codex manifest must exist: ${codexManifest}`);

  const codexParsed = JSON.parse(fs.readFileSync(codexManifest, "utf8"));
  assert.ok(codexParsed.name, `${CODEX_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} must have a name`);
  assert.ok(codexParsed.version, `${CODEX_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} must have a version`);

  // Byte-identity gate. plugin-info.mjs's "single source of truth" claim relies on
  // both manifests being indistinguishable; without this assertion the two files
  // could drift the moment a contributor edits one and forgets the other.
  // Asserting parsed-JSON deep equality also catches any reordering or whitespace
  // change that JSON.parse normalises away.
  const codexBytes = fs.readFileSync(codexManifest, "utf8");
  const claudeBytes = fs.readFileSync(claudeManifest, "utf8");
  assert.equal(codexBytes, claudeBytes,
    `${CODEX_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} and ${CLAUDE_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} must be byte-identical ` +
    "(both files are the canonical plugin manifest; drift between them silently breaks " +
    "either Claude Code or Codex). If you intentionally edited one, mirror the change to the other.");

  const claudeParsed = JSON.parse(claudeBytes);
  assert.deepStrictEqual(codexParsed, claudeParsed,
    "parsed manifests must be deep-equal across both host directories");
});

test(`install: ${AGENTS_DIR_NAME}/${OPENAI_AGENT_FILENAME} exists with valid Codex schema`, () => {
  const yamlPath = path.join(PLUGIN_ROOT, AGENTS_DIR_NAME, OPENAI_AGENT_FILENAME);
  assert.ok(fs.existsSync(yamlPath), `${AGENTS_DIR_NAME}/${OPENAI_AGENT_FILENAME} must exist: ${yamlPath}`);

  const content = fs.readFileSync(yamlPath, "utf8");
  // Lightweight schema check via regex — avoids a yaml dep, mirrors upstream's
  // pattern of pure-JS test deps. Real YAML parsers in Codex do the actual schema
  // validation at install time; we just catch egregious typos here.
  assert.match(content, /^interface:/m, "must have top-level 'interface:' key");
  assert.match(content, /^\s+display_name:/m, "interface must have 'display_name'");
  assert.match(content, /^\s+short_description:/m, "interface must have 'short_description'");
  assert.match(content, /^\s+default_prompt:/m, "interface must have 'default_prompt'");
  assert.match(content, /^policy:/m, "must have top-level 'policy:' key");
  assert.match(content, /^\s+allow_implicit_invocation:/m, "policy must specify 'allow_implicit_invocation'");
});

test(`install: Claude Code's ${CLAUDE_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} still parses (existing surface preserved)`, () => {
  const pluginJson = manifestPath("claude");
  assert.ok(fs.existsSync(pluginJson), "Claude Code plugin manifest must exist");
  const parsed = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
  assert.ok(parsed.name, `${PLUGIN_MANIFEST_FILENAME} must have a name`);
  assert.ok(parsed.version, `${PLUGIN_MANIFEST_FILENAME} must have a version`);
});

// ─── 2. Runtime works under both env shapes ────────────────────────────────

test("install: runtime --help succeeds (precondition for either host)", () => {
  const result = runNode(["--help"]);
  assert.equal(result.status, 0, `--help must exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, "--help output must contain Usage");
});

test(`install: 'setup --json' succeeds under Claude env shape (${CLAUDE_HOST_SIGNAL_ENV} + ${CLAUDE_PLUGIN_DATA_ENV} set)`, () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX_CLAUDE_ENV));
  // Claude Code's session lifecycle hook writes a real session.env file. The
  // runtime now stat()s this path before treating CLAUDE_HOST_SIGNAL_ENV as a
  // Claude host signal — so the test must actually create the file, not just
  // set the var to a nonexistent path.
  const envFile = path.join(pluginDataDir, SESSION_ENV_FILENAME);
  fs.writeFileSync(envFile, SESSION_ENV_PLACEHOLDER, "utf8");
  try {
    const result = runNode(["setup", "--json"], {
      env: {
        ...process.env,
        [CLAUDE_HOST_SIGNAL_ENV]: envFile,
        [CLAUDE_PLUGIN_DATA_ENV]: pluginDataDir
      }
    });
    assert.equal(result.status, 0, `setup must exit 0 under Claude env; stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.geminiAvailable, "boolean", "setup must return geminiAvailable boolean");
    assert.equal(typeof report.npmAvailable, "boolean", "setup must return npmAvailable boolean");
  } finally {
    fs.rmSync(pluginDataDir, { recursive: true, force: true });
  }
});

test(`install: 'setup --json' succeeds under Codex env shape (${CLAUDE_HOST_SIGNAL_ENV} + ${CLAUDE_PLUGIN_DATA_ENV} both unset)`, () => {
  const env = { ...process.env };
  delete env[CLAUDE_HOST_SIGNAL_ENV];
  delete env[CLAUDE_PLUGIN_DATA_ENV];
  delete env[SESSION_ID_ENV];

  const result = runNode(["setup", "--json"], { env });
  assert.equal(result.status, 0, `setup must exit 0 under Codex env; stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.geminiAvailable, "boolean", "setup must return geminiAvailable boolean");
});

// ─── 3. State paths don't collide between hosts ───────────────────────────

test("install: state paths under Claude vs Codex env shapes are different roots", async () => {
  const { resolveStateDir } = await import(STATE_LIB_PATH);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX_WORKSPACE));
  initGitRepo(workspace);
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX_PLUGIN_DATA));
  const claudeEnvFile = path.join(pluginDataDir, SESSION_ENV_FILENAME);
  // Runtime requires the host signal env var to point at a REAL file (not just be set).
  fs.writeFileSync(claudeEnvFile, SESSION_ENV_PLACEHOLDER, "utf8");

  try {
    // Claude Code shape: BOTH host signal env vars must be set for the runtime
    // to use Claude's state root. Setting only one is not enough — that
    // protects against users who export CLAUDE_PLUGIN_DATA in shell rc and
    // accidentally pull Codex into Claude's state tree.
    const claudeState = withEnv(
      { [CLAUDE_HOST_SIGNAL_ENV]: claudeEnvFile, [CLAUDE_PLUGIN_DATA_ENV]: pluginDataDir },
      () => resolveStateDir(workspace)
    );
    const codexState = withEnv(
      { [CLAUDE_HOST_SIGNAL_ENV]: undefined, [CLAUDE_PLUGIN_DATA_ENV]: undefined },
      () => resolveStateDir(workspace)
    );

    assert.notEqual(claudeState, codexState, "Claude and Codex state roots must differ");
    assert.ok(
      claudeState.startsWith(path.join(pluginDataDir, STATE_DIR_NAME)),
      `Claude state must be under ${CLAUDE_PLUGIN_DATA_ENV}/${STATE_DIR_NAME}; got ${claudeState}`
    );
    assert.ok(
      codexState.startsWith(path.join(os.tmpdir(), FALLBACK_STATE_ROOT_NAME)),
      `Codex state must fall back to os.tmpdir()/${FALLBACK_STATE_ROOT_NAME}; got ${codexState}`
    );

    // Defense-in-depth: setting CLAUDE_PLUGIN_DATA WITHOUT the host signal
    // (e.g. user exported CLAUDE_PLUGIN_DATA in shell rc but is running Codex)
    // must NOT leak into Claude's state root.
    const codexWithLooseClaudeData = withEnv(
      { [CLAUDE_HOST_SIGNAL_ENV]: undefined, [CLAUDE_PLUGIN_DATA_ENV]: pluginDataDir },
      () => resolveStateDir(workspace)
    );
    assert.ok(
      codexWithLooseClaudeData.startsWith(path.join(os.tmpdir(), FALLBACK_STATE_ROOT_NAME)),
      `Codex must ignore ${CLAUDE_PLUGIN_DATA_ENV} when ${CLAUDE_HOST_SIGNAL_ENV} is unset; got ${codexWithLooseClaudeData}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(pluginDataDir, { recursive: true, force: true });
  }
});

test("install: state dir is identical when accessed via symlink vs realpath", async () => {
  // The actual real-world bug this catches: one host runs from /Users/x/repo
  // (the realpath) while the other runs from /Users/x/symlink-to-repo (a
  // symlink to the same repo). If resolveStateDir hashes the *string* path
  // and not the realpath, both hosts would write to different state dirs
  // for the SAME workspace, silently bifurcating jobs. resolveWorkspaceRoot
  // calls `git rev-parse --show-toplevel`, which returns the realpath, so
  // this should be safe — but the test pins the invariant.
  const { resolveStateDir } = await import(STATE_LIB_PATH);

  const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX_REALPATH));
  initGitRepo(realRepo);

  const symlinkParent = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX_SYMPARENT));
  const symlinkRepo = path.join(symlinkParent, "repo-symlink");

  try {
    fs.symlinkSync(realRepo, symlinkRepo);

    // Force Codex env shape so both calls land under the fallback state root.
    const stateFromReal = withEnv(
      { [CLAUDE_HOST_SIGNAL_ENV]: undefined, [CLAUDE_PLUGIN_DATA_ENV]: undefined },
      () => resolveStateDir(realRepo)
    );
    const stateFromSymlink = withEnv(
      { [CLAUDE_HOST_SIGNAL_ENV]: undefined, [CLAUDE_PLUGIN_DATA_ENV]: undefined },
      () => resolveStateDir(symlinkRepo)
    );

    assert.equal(
      stateFromReal,
      stateFromSymlink,
      "state dir resolved via symlink must match state dir resolved via realpath — " +
      "otherwise two hosts running in the same repo via different paths would " +
      "silently bifurcate jobs"
    );
  } finally {
    fs.rmSync(realRepo, { recursive: true, force: true });
    fs.rmSync(symlinkParent, { recursive: true, force: true });
  }
});

// ─── 4. Plugin source tree is install-ready for Codex's plugin manager ───

test("install: plugin source dir contains all files Codex's marketplace install requires", () => {
  // A Codex plugin marketplace entry of the form
  //   { source: { source: "local", path: "<repo>/<source-dir>" } }
  // tells Codex to copy that subtree into ~/.codex/plugins/cache/<MARKETPLACE>/
  // <PLUGIN>/<VERSION>/. For the install to succeed and the plugin to be
  // usable, the source dir must contain the canonical Codex manifest plus
  // the runtime entry points the manifest implicitly references.
  const requiredFiles = [
    path.join(CODEX_PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILENAME),   // canonical Codex manifest
    path.join(CLAUDE_PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILENAME),  // Claude Code manifest (parity)
    RUNTIME_SCRIPT_RELATIVE,
    BROKER_SCRIPT_RELATIVE,
    HOOKS_FILE_RELATIVE
  ];

  for (const rel of requiredFiles) {
    const abs = pluginSourcePath(rel);
    assert.ok(fs.existsSync(abs),
      `plugin source dir is missing required file for Codex install: ${rel} ` +
      `(Codex's plugin manager copies the source dir into ~/.codex/plugins/cache/...; ` +
      `every file referenced by ${CODEX_PLUGIN_DIR_NAME}/${PLUGIN_MANIFEST_FILENAME} must be present here)`);
  }
});

test(`install: ${MARKETPLACE_MANIFEST_FILENAME} source.path is relative and points inside the repo`, () => {
  // The fork's marketplace.json points at the plugin source dir. Codex's docs
  // require `./`-prefixed paths relative to the marketplace.json's directory.
  const marketplacePath = path.join(PLUGIN_ROOT, CLAUDE_PLUGIN_DIR_NAME, MARKETPLACE_MANIFEST_FILENAME);
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));

  assert.ok(Array.isArray(marketplace.plugins), "marketplace must have plugins[]");
  assert.ok(marketplace.plugins.length > 0, "marketplace must list at least one plugin");

  for (const plugin of marketplace.plugins) {
    const src = plugin.source;
    // Either string ("./plugins/gemini") or object ({source, path}). Both forms
    // are valid per the Codex spec and ecosystem precedent.
    const srcPath = typeof src === "string" ? src : src?.path;
    assert.ok(srcPath, `plugin entry must have source path; entry: ${JSON.stringify(plugin)}`);
    assert.ok(srcPath.startsWith("./"),
      `source path must be relative with ./ prefix per Codex docs; got '${srcPath}'`);

    // The path must resolve to a real directory inside the repo.
    const resolvedDir = path.join(PLUGIN_ROOT, srcPath);
    assert.ok(fs.existsSync(resolvedDir),
      `marketplace points at non-existent plugin source: ${resolvedDir}`);
    assert.ok(fs.statSync(resolvedDir).isDirectory(),
      `marketplace source.path must be a directory: ${resolvedDir}`);
  }
});

// ─── helpers ───────────────────────────────────────────────────────────────

function initGitRepo(cwd) {
  spawnSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd, stdio: "ignore" });
}
