/**
 * Integration test for `getGeminiAuthStatus` after the v2 transport swap.
 *
 * Where prior tests covered CliTransport in isolation, this test exercises
 * the full call chain post-swap:
 *   `getGeminiAuthStatus` (caller)
 *     → `geminiBackend.transports.cli` (transport factory, swapped)
 *       → `createCliTransport` → real subprocess
 *       → mock `gemini --acp` JSON-RPC handshake
 *
 * The mock binary advertises `oauth-personal` from `initialize` and
 * answers `authenticate` with `{authenticated: true}`, so the auth path
 * resolves on the first method in the priority order.
 *
 * The test mutates the underlying transport-factory binding to point at
 * the mock — production code uses the canonical `gemini --acp`. This is
 * the same `command`/`args` override seam documented on `BackendConfig`.
 */

import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

// Load from the vendored copy: the SUT (getGeminiAuthStatus) imports
// `#lib/backends/gemini.mjs` via plugins/gemini/package.json's imports map,
// which resolves to plugins/gemini/lib/. Spying on the repo-root copy here
// would target a different module instance and silently miss.
import { geminiBackend } from "../../plugins/gemini/lib/backends/gemini.mjs";
import { getGeminiAuthStatus } from "../../plugins/gemini/scripts/lib/gemini.mjs";

const MOCK_PATH = path.resolve(new URL("../mocks/gemini-mock.mjs", import.meta.url).pathname);

/** @type {Record<string, string | undefined>} */
let savedEnv = {};

/** @type {((config?: any) => any) | null} */
let savedCli = null;

beforeEach(() => {
  // Strip env vars that short-circuit getGeminiAuthStatus before it reaches
  // the ACP path. We're specifically testing the swapped subprocess path.
  savedEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  };
  // Reflect.deleteProperty avoids biome's noDelete lint while preserving the
  // correct semantics for env removal (process.env.X = undefined would set it
  // to the literal string "undefined" on Node, which we don't want).
  Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
  Reflect.deleteProperty(process.env, "GOOGLE_API_KEY");
  Reflect.deleteProperty(process.env, "GOOGLE_APPLICATION_CREDENTIALS");

  // Redirect the cli transport at the mock binary by patching the factory
  // in place. This is cleaner than PATH shimming for an integration test
  // because (a) it doesn't require writing a wrapper script to disk, and
  // (b) it's reversible — we restore in afterEach.
  savedCli = geminiBackend.transports.cli;
  geminiBackend.transports.cli = (config = {}) =>
    /** @type {any} */ (savedCli)({
      ...config,
      command: process.execPath,
      args: [MOCK_PATH, "--acp"]
    });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  if (savedCli) geminiBackend.transports.cli = savedCli;
});

test("getGeminiAuthStatus: ACP path returns oauth-personal when mock authenticates", async () => {
  const result = await getGeminiAuthStatus(process.cwd());
  expect(result).toEqual({ authenticated: true, method: "oauth-personal" });
});

test("getGeminiAuthStatus: GEMINI_API_KEY short-circuits before ACP path", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const result = await getGeminiAuthStatus(process.cwd());
  // Returns immediately as api_key — never spawns the subprocess.
  expect(result).toEqual({ authenticated: true, method: "api_key" });
});

test("getGeminiAuthStatus: GOOGLE_API_KEY short-circuits before ACP path", async () => {
  process.env.GOOGLE_API_KEY = "test-key";
  const result = await getGeminiAuthStatus(process.cwd());
  expect(result).toEqual({ authenticated: true, method: "google_api_key" });
});

test("getGeminiAuthStatus: returns unauthenticated when subprocess spawn fails", async () => {
  // Point the factory at a binary that doesn't exist; the v2 path swallows
  // the spawn error in its catch and returns the unauthenticated shape.
  geminiBackend.transports.cli = (config = {}) =>
    /** @type {any} */ (savedCli)({
      ...config,
      command: "/no/such/binary/anywhere",
      args: []
    });
  const result = await getGeminiAuthStatus(process.cwd());
  expect(result).toEqual({ authenticated: false, method: null });
});
