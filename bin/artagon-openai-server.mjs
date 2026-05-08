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
  --version      print version
  --help         print this message
`;

function printUsage(stream = process.stderr) {
  stream.write(USAGE);
}

function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ port?: number, host?: string, cors?: string, version?: boolean, help?: boolean }} */
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

  const facade = createOpenAiFacadeServer({
    port: opts.port,
    host: opts.host,
    cors
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
