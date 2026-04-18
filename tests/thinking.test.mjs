import test from "node:test";
import assert from "node:assert/strict";

import { resolveThinkingConfig, THINKING_LEVELS } from "../plugins/gemini/scripts/lib/thinking.mjs";

test("THINKING_LEVELS enumerates the four accepted levels in order", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "low", "medium", "high"]);
});

test("resolveThinkingConfig returns empty config for undefined level (caller omitted flag)", () => {
  const result = resolveThinkingConfig(undefined, "gemini-3-pro");
  assert.deepEqual(result, { thinkingLevel: undefined, thinkingBudget: undefined, notes: [] });
});

test("resolveThinkingConfig maps Gemini 3 pro to thinkingLevel", () => {
  assert.deepEqual(resolveThinkingConfig("low", "gemini-3-pro"), {
    thinkingLevel: "low",
    thinkingBudget: undefined,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("high", "gemini-3-pro"), {
    thinkingLevel: "high",
    thinkingBudget: undefined,
    notes: []
  });
});

test("resolveThinkingConfig recognizes Gemini 3 point releases like gemini-3.1-pro-preview", () => {
  assert.deepEqual(resolveThinkingConfig("high", "gemini-3.1-pro-preview"), {
    thinkingLevel: "high",
    thinkingBudget: undefined,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("low", "gemini-3.1-flash-lite-preview"), {
    thinkingLevel: "low",
    thinkingBudget: undefined,
    notes: []
  });
});

test("resolveThinkingConfig medium on Gemini 3 leaves config empty (model dynamic default)", () => {
  const result = resolveThinkingConfig("medium", "gemini-3-pro");
  assert.deepEqual(result, { thinkingLevel: undefined, thinkingBudget: undefined, notes: [] });
});

test("resolveThinkingConfig off on Gemini 3 clamps to low with a note", () => {
  const result = resolveThinkingConfig("off", "gemini-3-flash-preview");
  assert.equal(result.thinkingLevel, "low");
  assert.equal(result.thinkingBudget, undefined);
  assert.match(result.notes[0], /clamped.*off.*low/i);
});

test("resolveThinkingConfig maps Gemini 2.5 flash to thinkingBudget numbers", () => {
  assert.deepEqual(resolveThinkingConfig("off", "gemini-2.5-flash"), {
    thinkingLevel: undefined,
    thinkingBudget: 0,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("low", "gemini-2.5-flash"), {
    thinkingLevel: undefined,
    thinkingBudget: 2048,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("medium", "gemini-2.5-flash"), {
    thinkingLevel: undefined,
    thinkingBudget: -1,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("high", "gemini-2.5-flash"), {
    thinkingLevel: undefined,
    thinkingBudget: 24576,
    notes: []
  });
});

test("resolveThinkingConfig maps Gemini 2.5 flash-lite to the same thinkingBudget numbers as flash", () => {
  assert.deepEqual(resolveThinkingConfig("off", "gemini-2.5-flash-lite"), {
    thinkingLevel: undefined,
    thinkingBudget: 0,
    notes: []
  });
  assert.deepEqual(resolveThinkingConfig("high", "gemini-2.5-flash-lite"), {
    thinkingLevel: undefined,
    thinkingBudget: 24576,
    notes: []
  });
});

test("resolveThinkingConfig off on Gemini 2.5 pro clamps to low with a note (pro min is 128)", () => {
  const result = resolveThinkingConfig("off", "gemini-2.5-pro");
  assert.equal(result.thinkingBudget, 2048);
  assert.equal(result.thinkingLevel, undefined);
  assert.match(result.notes[0], /clamped.*off.*low/i);
});

test("resolveThinkingConfig on unknown model leaves config empty and adds a note", () => {
  const result = resolveThinkingConfig("high", "some-new-model");
  assert.equal(result.thinkingLevel, undefined);
  assert.equal(result.thinkingBudget, undefined);
  assert.match(result.notes[0], /unknown model family/i);
});

test("resolveThinkingConfig throws on invalid level", () => {
  assert.throws(() => resolveThinkingConfig("purple", "gemini-3-pro"), /invalid thinking level/i);
});

test("resolveThinkingConfig accepts null modelId as unknown", () => {
  const result = resolveThinkingConfig("medium", null);
  assert.deepEqual(result, { thinkingLevel: undefined, thinkingBudget: undefined, notes: ["unknown model family; thinking config not delivered"] });
});
