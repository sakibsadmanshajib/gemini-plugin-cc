/**
 * AcpSession conformance suite run against `codexBackend.transports.cli`.
 *
 * Sibling of `gemini-cli-conformance.test.mjs`. Both backends share the
 * same `createCliTransport` plumbing, but each backend's factory is the
 * unit of composition the runtime actually constructs — running the
 * conformance suite against EACH factory locks in that the per-backend
 * configuration (command, default args, env handling) doesn't break the
 * AcpSession contract.
 *
 * The mock binary at `tests/mocks/gemini-mock.mjs` is generic ACP — it
 * speaks JSON-RPC regardless of who launched it. We use it here too via
 * the codex factory's `args` test seam (added for parity with gemini's).
 */

import path from "node:path";

import { codexBackend } from "#lib/backends/codex.mjs";
import { runConformanceSuite } from "#lib/test-utils/conformance.mjs";

const MOCK_PATH = path.resolve(new URL("../mocks/gemini-mock.mjs", import.meta.url).pathname);

runConformanceSuite("codexBackend.transports.cli (mock binary)", () =>
  codexBackend.transports.cli({
    command: process.execPath,
    args: [MOCK_PATH, "--acp"]
  })
);
