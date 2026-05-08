#!/usr/bin/env node
/**
 * Generate the Homebrew formula for artagon-agent-cli-plugin from
 * package.json + the published npm tarball.
 *
 * What this gives the homebrew-tap repo: a single-file formula
 * (`artagon-agent-cli-plugin.rb`) with the version, npm tarball URL,
 * and SHA-256 already filled in. The tap repo's CI can call this
 * after each release of THIS repo and commit the result — no manual
 * sed loop, no human-in-the-loop SHA copy/paste.
 *
 * Argv parsing uses commander — the canonical Node CLI library.
 *
 * Usage:
 *   node scripts/generate-homebrew-formula.mjs              # write to stdout
 *   node scripts/generate-homebrew-formula.mjs > out.rb     # capture
 *   node scripts/generate-homebrew-formula.mjs --version 1.2.3 --output Formula/...
 *
 * Resolution:
 *   - Version: --version flag, else package.json's `version` field
 *   - Tarball URL: registry.npmjs.org/<name>/-/<name>-<version>.tgz
 *     (the canonical npm-published location; matches what
 *     `pnpm publish` deposits)
 *   - SHA-256: fetched from the registry's metadata
 *     (`packument.versions[v].dist.shasum` is SHA-1, so we re-compute
 *     SHA-256 from the actual tarball download)
 *
 * Exit codes:
 *   0 success
 *   1 fetch/network error (e.g. version not yet published)
 *   2 usage error (bad flags, missing files)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const program = new Command();

program
  .name("generate-homebrew-formula")
  .description("Render the Homebrew formula for artagon-agent-cli-plugin from a published version")
  // The script intentionally takes its package version from
  // package.json by default, so commander's --version (which would
  // print and exit) would be confusing here. Disable the auto-flag.
  .option("-V, --pkg-version <ver>", "formula version (default: package.json's version field)")
  .option("-o, --output <path>", "write to this path (default: stdout)");

program.exitOverride((err) => {
  if (err.code === "commander.helpDisplayed") process.exit(0);
  process.exit(2);
});

program.parse(process.argv);
const opts = program.opts();

/**
 * Fetch the npm tarball and compute SHA-256. Streaming would be more
 * efficient for huge tarballs, but our package is small (a few MB);
 * just buffer-and-hash for simplicity.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchTarballSha256(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the Ruby formula text.
 *
 * @param {{ name: string, version: string, sha256: string, url: string }} meta
 * @returns {string}
 */
function renderFormula(meta) {
  // Class name is the PascalCased package name minus dashes.
  const className = meta.name
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return `class ${className} < Formula
  desc     "Multi-backend agent CLI plugin suite for Claude, Codex, and Gemini"
  homepage "https://github.com/artagon/artagon-agent-cli-plugin"
  url      "${meta.url}"
  sha256   "${meta.sha256}"
  license  "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/artagon-agent --version")
    assert_match version.to_s, shell_output("#{bin}/artagon-stats --version")
    assert_match version.to_s, shell_output("#{bin}/artagon-openai-server --version")
  end
end
`;
}

const version = opts.pkgVersion ?? PKG.version;
const url = `https://registry.npmjs.org/${PKG.name}/-/${PKG.name}-${version}.tgz`;

let sha256;
try {
  sha256 = await fetchTarballSha256(url);
} catch (err) {
  process.stderr.write(
    `generate-homebrew-formula: ${/** @type {Error} */ (err).message}\n` +
      `(version "${version}" may not yet be published; check npm registry)\n`
  );
  process.exit(1);
}

const formula = renderFormula({ name: PKG.name, version, sha256, url });

if (opts.output) {
  fs.writeFileSync(opts.output, formula, { mode: 0o644 });
  process.stderr.write(`generate-homebrew-formula: wrote ${opts.output}\n`);
} else {
  process.stdout.write(formula);
}
