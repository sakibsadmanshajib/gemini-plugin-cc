#!/usr/bin/env node
/**
 * `artagon-openai-server` — start the OpenAI Chat Completions facade.
 *
 * Usage:
 *   artagon-openai-server [flags]
 *
 * Once running, point any OpenAI SDK at `http://<host>:<port>` and use
 * one of the three backends as the model:
 *
 *   from openai import OpenAI
 *   client = OpenAI(base_url="http://localhost:3000/v1", api_key="unused")
 *   client.chat.completions.create(
 *     model="claude-sonnet-4-6",   # or codex / gemini / explicit "<backend>:<id>"
 *     messages=[{"role": "user", "content": "summarize this repo"}]
 *   )
 *
 * Argv parsing uses commander — the canonical Node CLI library.
 *
 * Auth + CORS are off by default; bind defaults to 127.0.0.1 (loopback
 * only). Run behind a reverse proxy that handles auth before exposing
 * publicly, OR enable --api-key (constant-time-compared bearer tokens).
 *
 * Lifecycle:
 *   - Listens until SIGINT / SIGTERM, then closes the server gracefully.
 *   - Exit codes: 0 clean shutdown, 1 listen error, 2 usage error.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import { createOpenAiFacadeServer } from "#lib/server/openai-facade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

/** @param {string} value */
function parsePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError("must be an integer in [0, 65535]");
  }
  return n;
}

const program = new Command();

program
  .name("artagon-openai-server")
  .description("Start the OpenAI Chat Completions facade in front of the multi-backend CLIs")
  .version(PKG.version, "-v, --version")
  .option("--port <n>", "listen port (0 = OS-assigned)", parsePort, 0)
  .option("--host <h>", "bind host", "127.0.0.1")
  .option(
    "--cors <spec>",
    'enable CORS. Spec is "*" (allow any), a single origin, or a comma-separated allowlist. Env: ARTAGON_FACADE_CORS'
  )
  .option(
    "--api-key <k>",
    "require Authorization: Bearer <k> on /v1/* requests. Comma-separated for multi-key allowlist. /health is exempt. Env: ARTAGON_FACADE_API_KEY"
  )
  .option(
    "--api-key-file <path>",
    "read the key(s) from a file (one per line OR comma-separated). Safer than --api-key — key isn't visible in `ps` output. Mutually exclusive with --api-key."
  );

program.exitOverride((err) => {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
    process.exit(0);
  }
  process.exit(2);
});

program.parse(process.argv);
const opts = program.opts();

// CLI --cors accepts the same shapes as $ARTAGON_FACADE_CORS:
//   "*" / "1" / "true" → wildcard allow-any
//   "<origin>"          → single-origin allowlist
//   "<a>,<b>,..."       → multi-origin allowlist
// Pre-parse here so the facade option types stay clean (single
// string is a single-origin allowlist; arrays cover multi-origin).
let cors;
if (opts.cors !== undefined) {
  const trimmed = opts.cors.trim();
  if (trimmed === "*" || trimmed === "1" || trimmed === "true") {
    cors = true;
  } else if (trimmed.includes(",")) {
    cors = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (trimmed) {
    cors = trimmed;
  }
}

// CLI --api-key / --api-key-file resolution. The file path wins
// when both are passed so users debugging can override their env
// setup; --api-key alone is supported but exposes the key in
// `ps` output, so it's documented as the less-secure path.
let apiKey;
if (opts.apiKey !== undefined && opts.apiKeyFile !== undefined) {
  process.stderr.write(
    "artagon-openai-server: --api-key and --api-key-file are mutually exclusive\n"
  );
  process.exit(2);
}
if (opts.apiKeyFile !== undefined) {
  /** @type {string} */
  let rawKeySource;
  try {
    rawKeySource = fs.readFileSync(opts.apiKeyFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `artagon-openai-server: failed to read --api-key-file ${opts.apiKeyFile}: ${message}\n`
    );
    process.exit(2);
  }
  // Split on newlines first; fallback to comma if the file is one-line.
  const lines = rawKeySource
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (lines.length > 1) {
    apiKey = lines;
  } else if (lines.length === 1) {
    const single = lines[0];
    apiKey = single.includes(",")
      ? single
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : single;
  }
} else if (opts.apiKey !== undefined) {
  const trimmed = opts.apiKey.trim();
  if (trimmed.includes(",")) {
    apiKey = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (trimmed) {
    apiKey = trimmed;
  }
}

const facade = createOpenAiFacadeServer({
  port: opts.port,
  host: opts.host,
  cors,
  apiKey
});

let address;
try {
  address = await facade.listen();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`artagon-openai-server: listen failed: ${message}\n`);
  process.exit(1);
}

process.stdout.write(
  `artagon-openai-server listening at http://${address.host}:${address.port}\n` +
    "  POST /v1/chat/completions   — OpenAI Chat Completions API\n" +
    "  GET  /v1/models             — list backends\n" +
    "  GET  /health                — liveness\n"
);

// Graceful shutdown on SIGINT / SIGTERM.
let shuttingDown = false;
const shutdown = async (/** @type {string} */ signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\nartagon-openai-server: ${signal} received, closing...\n`);
  await facade.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
