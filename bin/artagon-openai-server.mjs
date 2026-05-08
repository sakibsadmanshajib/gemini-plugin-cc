#!/usr/bin/env node
/**
 * `artagon-openai-server` — start the OpenAI Chat Completions facade.
 *
 * Usage:
 *   artagon-openai-server [flags]
 *
 *   --port <n>     listen port (default 0 = OS-assigned; print on stdout)
 *   --host <h>     bind host (default 127.0.0.1; loopback only)
 *   --version      print version and exit
 *   --help         print this message
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
 * The facade does NOT authenticate clients. Bind to 127.0.0.1 (default)
 * unless you've fronted it with a reverse proxy that handles auth.
 *
 * Lifecycle:
 *   - Listens until SIGINT / SIGTERM, then closes the server gracefully.
 *   - Exit codes: 0 clean shutdown, 1 listen error, 2 usage error.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createOpenAiFacadeServer } from "#lib/server/openai-facade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const USAGE = `artagon-openai-server [flags]

flags:
  --port <n>     listen port (default 0 = OS-assigned)
  --host <h>     bind host (default 127.0.0.1)
  --cors <spec>  enable CORS. Spec is "*" (allow any), a single
                 origin (e.g. "http://localhost:3000"), or a
                 comma-separated allowlist. Off by default.
                 Env: ARTAGON_FACADE_CORS
  --api-key <k>  require Authorization: Bearer <k> on /v1/* requests.
                 Comma-separated for multi-key allowlist. /health is
                 exempt. Off by default.
                 Env: ARTAGON_FACADE_API_KEY
  --api-key-file <path>
                 read the key(s) from a file (trimmed; one per line OR
                 comma-separated). Safer than --api-key since the key
                 isn't visible in ps output. Mutually exclusive with
                 --api-key.
  --version      print version
  --help         print this message
`;

function printUsage(stream = process.stderr) {
  stream.write(USAGE);
}

function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ port?: number, host?: string, cors?: string, apiKey?: string, apiKeyFile?: string, version?: boolean, help?: boolean }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") out.help = true;
    else if (tok === "--version" || tok === "-v") out.version = true;
    else if (tok === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`invalid --port: ${argv[i]}`);
      }
      out.port = n;
    } else if (tok === "--host") {
      const h = argv[++i];
      if (!h) throw new Error("--host requires a value");
      out.host = h;
    } else if (tok === "--cors") {
      const c = argv[++i];
      if (c == null) throw new Error("--cors requires a value (e.g. * or http://localhost:3000)");
      out.cors = c;
    } else if (tok === "--api-key") {
      const k = argv[++i];
      if (k == null) throw new Error("--api-key requires a value");
      out.apiKey = k;
    } else if (tok === "--api-key-file") {
      const p = argv[++i];
      if (p == null) throw new Error("--api-key-file requires a path");
      out.apiKeyFile = p;
    } else {
      throw new Error(`unknown flag: ${tok}`);
    }
  }
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`artagon-openai-server: ${/** @type {Error} */ (err).message}\n\n`);
    printUsage();
    process.exit(2);
  }

  if (opts.version) {
    process.stdout.write(`${PKG.version}\n`);
    return;
  }
  if (opts.help) {
    printUsage(process.stdout);
    return;
  }

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
  /** @type {string | undefined} */
  let rawKeySource;
  if (opts.apiKeyFile !== undefined) {
    try {
      // Read the file. Newline-separated keys (one per line) are split
      // into an allowlist; a single line is treated as a single key
      // (or comma-separated, same as --api-key).
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
      // Single line — accept either a comma-separated list or a bare key.
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
}

await main();
