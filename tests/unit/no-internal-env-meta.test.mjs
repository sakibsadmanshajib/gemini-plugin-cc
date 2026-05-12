/**
 * Meta-tests for `scripts/no-internal-env.mjs`. The pretest guard
 * scans `lib/` for `process.env.ARTAGON_*` / `ACP_WIRE_LOG*` reads
 * and fails CI if any are found outside the AgentContext boundary.
 * Without these meta-tests, a future refactor that subtly broke the
 * regex would silently pass on every CI run — the guard would
 * report "no violations" on a file that actually has them.
 *
 * These tests drive the `lineHasViolation` helper through each
 * documented violation shape (positive cases) and through legitimate
 * non-violation lines (negative cases). If the regex breaks in
 * either direction the test fails immediately.
 */

import { expect, test } from "vitest";

import { lineHasViolation } from "../../scripts/no-internal-env.mjs";

test("positive: process.env.ARTAGON_FOO property access is flagged", () => {
  expect(lineHasViolation("const x = process.env.ARTAGON_STREAMING;")).toBe(true);
  expect(lineHasViolation("if (process.env.ARTAGON_USE_FACADE === '1') {")).toBe(true);
});

test("positive: env.ARTAGON_FOO (any identifier prefix, not just process) is flagged", () => {
  expect(lineHasViolation("const x = env.ARTAGON_STREAMING;")).toBe(true);
  expect(lineHasViolation("opts.env.ARTAGON_COST_LOG")).toBe(true);
});

test("positive: bracket access env['ARTAGON_FOO'] is flagged", () => {
  expect(lineHasViolation(`const x = env["ARTAGON_FOO"];`)).toBe(true);
  expect(lineHasViolation(`const y = env['ACP_WIRE_LOG'];`)).toBe(true);
});

test("positive: destructure const { ARTAGON_FOO } = process.env is flagged", () => {
  expect(lineHasViolation("const { ARTAGON_STREAMING } = process.env;")).toBe(true);
  expect(lineHasViolation("const { ARTAGON_USE_FACADE, ARTAGON_COST_LOG } = process.env;")).toBe(
    true
  );
});

test("positive: ACP_WIRE_LOG variant is flagged (separate alternation in the regex)", () => {
  expect(lineHasViolation("process.env.ACP_WIRE_LOG_RAW")).toBe(true);
  expect(lineHasViolation("env.ACP_WIRE_LOG")).toBe(true);
});

test("negative: pure comment lines are NOT flagged (docstrings can mention legacy names)", () => {
  expect(lineHasViolation(" * Reads ARTAGON_STREAMING and ACP_WIRE_LOG from env.")).toBe(false);
  expect(lineHasViolation("// see ARTAGON_USE_FACADE for the legacy flow")).toBe(false);
  expect(lineHasViolation("  // process.env.ARTAGON_FOO — historical reference")).toBe(false);
});

test("negative: provider-auth env vars are NOT flagged (they're external contracts)", () => {
  expect(lineHasViolation("const k = process.env.ANTHROPIC_API_KEY;")).toBe(false);
  expect(lineHasViolation("const k = process.env.OPENAI_API_KEY;")).toBe(false);
  expect(lineHasViolation("const k = process.env.GEMINI_API_KEY;")).toBe(false);
});

test("negative: host-set env vars are NOT flagged (XDG, HOME, TMPDIR, CLAUDE_PLUGIN_*)", () => {
  expect(lineHasViolation("const x = process.env.XDG_STATE_HOME;")).toBe(false);
  expect(lineHasViolation("const x = process.env.HOME;")).toBe(false);
  expect(lineHasViolation("const x = process.env.CLAUDE_PLUGIN_DIR;")).toBe(false);
});

test("negative: string literals containing 'ARTAGON_FOO' as data are NOT flagged", () => {
  // A line that LOOKS like it might match but is actually constructing
  // a string. The regex requires `<word>.ARTAGON_FOO` — a quoted string
  // alone doesn't satisfy the property-access shape.
  expect(lineHasViolation(`const name = "ARTAGON_USE_FACADE";`)).toBe(false);
});

test("self-test: every documented violation shape in the script's docstring matches the regex", () => {
  // The script's header docstring claims four patterns are caught:
  //   1. process.env.ARTAGON_FOO
  //   2. env.ARTAGON_FOO (any identifier)
  //   3. env["ARTAGON_FOO"] bracket
  //   4. const { ARTAGON_FOO } = process.env destructure
  // This test ensures the docstring's promises match the regex's
  // actual behavior. If a future refactor narrows the regex without
  // updating the docstring, this catches it.
  expect(lineHasViolation("a = process.env.ARTAGON_X;")).toBe(true);
  expect(lineHasViolation("a = ctx.env.ARTAGON_X;")).toBe(true);
  expect(lineHasViolation(`a = env["ARTAGON_X"];`)).toBe(true);
  expect(lineHasViolation("const { ARTAGON_X } = process.env;")).toBe(true);
});
