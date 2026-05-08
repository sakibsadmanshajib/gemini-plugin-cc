/**
 * Unit tests for `lib/feature-flags.mjs::getPluginVersion()`.
 *
 * The flag is plumbed-but-inert at modernize-toolchain landing; these tests pin
 * resolution semantics so v2-introducing changes can rely on the contract.
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { getPluginVersion, isV2 } from "#lib/feature-flags.mjs";

test("getPluginVersion: empty env defaults to v1", () => {
  assert.equal(getPluginVersion({}), "v1");
});

test("getPluginVersion: ACP_PLUGIN_VERSION=v1 returns v1", () => {
  assert.equal(getPluginVersion({ ACP_PLUGIN_VERSION: "v1" }), "v1");
});

test("getPluginVersion: ACP_PLUGIN_VERSION=v2 returns v2", () => {
  assert.equal(getPluginVersion({ ACP_PLUGIN_VERSION: "v2" }), "v2");
});

test("getPluginVersion: empty-string ACP_PLUGIN_VERSION defaults to v1", () => {
  assert.equal(getPluginVersion({ ACP_PLUGIN_VERSION: "" }), "v1");
});

test("getPluginVersion: unknown value falls back to v1 with stderr warning", () => {
  /** @type {string[]} */
  const stderrLines = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — narrow override for test capture
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    assert.equal(getPluginVersion({ ACP_PLUGIN_VERSION: "v99" }), "v1");
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(
    stderrLines.some((line) => line.includes("Unknown") && line.includes("v99")),
    `expected stderr to include warning; got: ${JSON.stringify(stderrLines)}`
  );
});

test("isV2: true only when ACP_PLUGIN_VERSION=v2", () => {
  assert.equal(isV2({}), false);
  assert.equal(isV2({ ACP_PLUGIN_VERSION: "v1" }), false);
  assert.equal(isV2({ ACP_PLUGIN_VERSION: "v2" }), true);
});
