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

import { provisionApiKey } from "#lib/server/api-key-store.mjs";
import { deleteManifest, writeManifest } from "#lib/server/facade-endpoint.mjs";
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
  )
  .option(
    "--auto-key",
    "self-provision a 512-byte CSPRNG bearer key. Stored in macOS Keychain (service=artagon-agent-cli-plugin) on darwin, otherwise in $XDG_STATE_HOME/artagon-agent-cli-plugin/api-key with mode 0600 under a 0700 dir. Idempotent — re-running returns the same key. The key is NEVER printed; the server only emits the retrieve-command for the operator to run separately."
  )
  .option(
    "--auto-key-rotate",
    "force generation of a fresh --auto-key, overwriting any existing entry. Implies --auto-key."
  )
  .option(
    "--auto-key-store <kind>",
    'override the auto-key backend: "keychain" or "file". Default is keychain on macOS, file elsewhere.',
    (value) => {
      if (value !== "keychain" && value !== "file") {
        throw new InvalidArgumentError('must be "keychain" or "file"');
      }
      return value;
    }
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

// CLI --api-key / --api-key-file / --auto-key resolution. The three
// options are mutually exclusive — picking one is a deliberate operator
// choice about how the key gets into the process.
//   --api-key        : key on argv (less secure: visible in `ps`)
//   --api-key-file   : key in a file the operator manages
//   --auto-key       : self-provision via Keychain (macOS) or 0o600 file
let apiKey;
const autoKeyRequested = Boolean(opts.autoKey || opts.autoKeyRotate);
const explicitKeySources = [opts.apiKey !== undefined, opts.apiKeyFile !== undefined].filter(
  Boolean
).length;
if (autoKeyRequested && explicitKeySources > 0) {
  process.stderr.write(
    "artagon-openai-server: --auto-key cannot be combined with --api-key or --api-key-file\n"
  );
  process.exit(2);
}
if (opts.apiKey !== undefined && opts.apiKeyFile !== undefined) {
  process.stderr.write(
    "artagon-openai-server: --api-key and --api-key-file are mutually exclusive\n"
  );
  process.exit(2);
}
if (autoKeyRequested) {
  // Provision (or re-read) the persistent key via Keychain or 0600 file.
  // We pass the resulting key into the facade as the bearer-allowlist
  // entry. The retrieve-command (NOT the key itself) is printed below.
  try {
    const provisioned = provisionApiKey({
      rotate: Boolean(opts.autoKeyRotate),
      force: opts.autoKeyStore
    });
    apiKey = provisioned.key;
    process.stderr.write(
      "\n" +
        "─── auto-key ──────────────────────────────────────────────────\n" +
        `  store     : ${provisioned.source} (${provisioned.location})\n` +
        `  status    : ${provisioned.rotated ? "freshly generated" : "reused existing"}\n` +
        "  retrieve  : (run this on the same machine to read the key)\n" +
        `              ${provisioned.retrieveCommand}\n` +
        "  use it    : Authorization: Bearer <retrieved-key>\n" +
        "  NOTE      : the key is never printed by this server. Use the\n" +
        "              retrieve command above to copy it into your client.\n" +
        "───────────────────────────────────────────────────────────────\n\n"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`artagon-openai-server: --auto-key provisioning failed: ${message}\n`);
    process.exit(2);
  }
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

// Endpoint manifest: where we're listening + (optionally) the auto-key
// retrieve command. Other tools (the dispatcher's ARTAGON_USE_FACADE=1
// path, future `artagon-agent --via-facade`) read this to find a
// running server without prior knowledge of the port. NEVER contains
// the bearer key itself — only the command to fetch it.
let autoKeyManifest = null;
if (autoKeyRequested) {
  try {
    // Read back the persistent key location (no rotation; just discover
    // where the key lives so the manifest can point a consumer at it).
    const probed = provisionApiKey({
      rotate: false,
      force: opts.autoKeyStore
    });
    autoKeyManifest = {
      store: probed.source,
      retrieveCommand: probed.retrieveCommand
    };
  } catch {
    // Best-effort: if reading the persistent store back fails the server
    // still runs, just without the manifest entry that points at it.
    autoKeyManifest = null;
  }
}
try {
  writeManifest({
    host: address.host,
    port: address.port,
    pid: process.pid,
    autoKey: autoKeyManifest
  });
} catch (err) {
  // Don't fail listen on manifest-write errors — observability nicety,
  // not a hard requirement. Log once and continue.
  process.stderr.write(`artagon-openai-server: manifest write failed: ${String(err)}\n`);
}

process.stdout.write(
  `artagon-openai-server listening at http://${address.host}:${address.port}\n` +
    "  POST /v1/chat/completions   — OpenAI Chat Completions API\n" +
    "  GET  /v1/models             — list backends\n" +
    "  GET  /health                — liveness\n"
);

// Graceful shutdown on SIGINT / SIGTERM.
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const shutdown = async (/** @type {string} */ signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\nartagon-openai-server: ${signal} received, closing...\n`);

  // Safety timer: if facade.close() can't drain in 10s (stuck keep-alive
  // connection, runner subprocess that won't yield, etc.) force-exit so
  // the parent shell isn't wedged. .unref() so we don't keep the loop
  // alive on a clean shutdown.
  const forceExit = setTimeout(() => {
    process.stderr.write(
      `artagon-openai-server: shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; force-exiting.\n`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await facade.close();
  } catch (err) {
    // Log but still exit cleanly — close() throwing means resources may
    // leak but holding the process open hoping for a re-try is worse for
    // the operator who already pressed Ctrl-C.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`artagon-openai-server: error during shutdown: ${message}\n`);
  }
  // Best-effort manifest cleanup. ENOENT is silent; other errors warn
  // but don't block exit.
  deleteManifest();
  process.exit(0);
};

// Wrap shutdown invocations to swallow async rejections at the signal-
// handler boundary. Without the .catch the runtime would print
// "Unhandled promise rejection" at the worst possible moment (during
// shutdown, when stderr is the only thing the user is watching).
const safeShutdown = (/** @type {string} */ signal) => {
  shutdown(signal).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`artagon-openai-server: shutdown handler crashed: ${message}\n`);
    process.exit(1);
  });
};
process.on("SIGINT", () => safeShutdown("SIGINT"));
process.on("SIGTERM", () => safeShutdown("SIGTERM"));
