/**
 * AcpSession conformance suite run against `geminiBackend.transports.cli`
 * pointed at the mock binary.
 *
 * Where `tests/unit/conformance.test.mjs` runs the suite against
 * MockBackend (in-memory), this file exercises the same suite against the
 * real `transports.cli → createCliTransport → spawned subprocess →
 * JSON-RPC over stdio` composition. A passing run proves the cli-factory
 * stack meets the AcpSession contract end-to-end.
 *
 * The mock binary is shadowed via the documented `command`/`args` test
 * seam on the cli factory's BackendConfig. No PATH manipulation, no
 * monkey-patching of `child_process.spawn`.
 */

import path from "node:path";

import { geminiBackend } from "#lib/backends/gemini.mjs";
import { runConformanceSuite } from "#lib/test-utils/conformance.mjs";

const MOCK_PATH = path.resolve(new URL("../mocks/gemini-mock.mjs", import.meta.url).pathname);

runConformanceSuite("geminiBackend.transports.cli (mock binary)", () =>
  geminiBackend.transports.cli({
    command: process.execPath,
    args: [MOCK_PATH, "--acp"]
  })
);
