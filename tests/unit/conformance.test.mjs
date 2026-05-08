/**
 * Apply the AcpSession conformance suite against every implementation we ship.
 *
 * MockBackend is the reference. As real transports land (CliTransport against
 * the ACP-mock gemini binary in integration tests, future SdkTransport, etc.)
 * each one re-runs this same suite via its own factory.
 */

import { runConformanceSuite } from "#lib/test-utils/conformance.mjs";
import { createMockBackend } from "#lib/test-utils/mock-backend.mjs";

runConformanceSuite("MockBackend", () => createMockBackend());
