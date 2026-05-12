/**
 * Unit tests for `lib/backends/discover-models.mjs`.
 *
 * Coverage:
 *   - getBackendModels per backend: includes canonical ids, dedup, alias
 *     grouping, default-flagging, sorted output (default first)
 *   - getAllBackendModels: spans all three backends
 *   - toOpenAiModelEntries: canonical id + every alias as separate entries
 */

import { describe, expect, test } from "vitest";

import {
  getAllBackendModels,
  getBackendModels,
  toOpenAiModelEntries
} from "#lib/backends/discover-models.mjs";
import { ALL_BACKEND_NAMES, BACKEND_NAMES } from "#lib/backends/names.mjs";

describe("getBackendModels(claude)", () => {
  const models = getBackendModels(BACKEND_NAMES.CLAUDE);

  test("canonical ids match claude-agent-acp's session/new catalog", () => {
    // claude-agent-acp 0.33 advertises `default`, `sonnet`, `haiku`
    // in `models.availableModels` — those are the modelIds it accepts
    // on session/set_model. Our MODEL_ALIASES collapses opus / opus-1m
    // / claude-opus-4-7-1m onto `default` (the only opus flavor the
    // agent exposes), and sonnet/haiku canonicals onto their short
    // forms. See lib/backends/claude.mjs for the table.
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual(["default", "haiku", "sonnet"]);
  });

  test("aliases collected against canonical ids", () => {
    const sonnet = models.find((m) => m.id === "sonnet");
    expect(sonnet?.aliases).toEqual(["claude-sonnet-4-6"]);
    const haiku = models.find((m) => m.id === "haiku");
    expect(haiku?.aliases).toEqual(["claude-haiku-4-5"]);
    // opus / opus-1m / claude-opus-4-7 / claude-opus-4-7-1m all
    // alias to `default` (claude-agent-acp's 1M-context opus).
    const opus = models.find((m) => m.id === "default");
    expect(opus?.aliases).toEqual(["claude-opus-4-7", "claude-opus-4-7-1m", "opus", "opus-1m"]);
  });

  test("default model flagged + sorted first", () => {
    expect(models[0].is_default).toBe(true);
    // Claude's `defaultModel` is "sonnet" → resolves to "sonnet"
    // (matches claude-agent-acp's accepted short id).
    expect(models[0].id).toBe("sonnet");
    // No other model has is_default = true.
    expect(models.filter((m) => m.is_default)).toHaveLength(1);
  });

  test("each model owned_by is the artagon-agent-cli-plugin label", () => {
    for (const m of models) {
      expect(m.owned_by).toBe("artagon-agent-cli-plugin (claude)");
    }
  });
});

describe("getBackendModels(codex)", () => {
  const models = getBackendModels(BACKEND_NAMES.CODEX);

  test("includes the gpt-5.x lineup supported for ChatGPT accounts", () => {
    const ids = models.map((m) => m.id);
    for (const expected of ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"]) {
      expect(ids).toContain(expected);
    }
  });

  test("default is gpt-5.5 (matches codexBackend.defaultModel)", () => {
    expect(models[0].is_default).toBe(true);
    expect(models[0].id).toBe("gpt-5.5");
  });
});

describe("getBackendModels(gemini)", () => {
  const models = getBackendModels(BACKEND_NAMES.GEMINI);

  test("includes auto-routing aliases + concrete ids", () => {
    const ids = models.map((m) => m.id);
    expect(ids).toContain("auto-gemini-3");
    expect(ids).toContain("gemini-3.1-pro-preview");
    expect(ids).toContain("gemini-3-flash-preview");
    expect(ids).toContain("gemini-2.5-pro");
  });

  test("`pro` and `flash` aliases attached to their canonical preview ids", () => {
    const proModel = models.find((m) => m.id === "gemini-3.1-pro-preview");
    expect(proModel?.aliases).toContain("pro");
    const flashModel = models.find((m) => m.id === "gemini-3-flash-preview");
    expect(flashModel?.aliases).toContain("flash");
  });

  test("default is auto-gemini-3", () => {
    expect(models[0].is_default).toBe(true);
    expect(models[0].id).toBe("auto-gemini-3");
  });
});

describe("getBackendModels — invalid input", () => {
  test("unknown backend returns empty array", () => {
    expect(getBackendModels(/** @type {any} */ ("bedrock"))).toEqual([]);
  });
});

describe("getAllBackendModels", () => {
  test("includes models from all three backends", () => {
    const models = getAllBackendModels();
    const backends = new Set(models.map((m) => m.backend));
    for (const b of ALL_BACKEND_NAMES) {
      expect(backends.has(b)).toBe(true);
    }
  });

  test("each model id is unique within a backend", () => {
    const models = getAllBackendModels();
    const seen = new Set();
    for (const m of models) {
      const key = `${m.backend}:${m.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("toOpenAiModelEntries", () => {
  test("canonical id + each alias appears as separate entry", () => {
    const entries = toOpenAiModelEntries({
      id: "claude-sonnet-4-6",
      backend: BACKEND_NAMES.CLAUDE,
      aliases: ["sonnet"],
      is_default: true,
      owned_by: "artagon-agent-cli-plugin (claude)"
    });
    expect(entries.map((e) => e.id)).toEqual(["claude-sonnet-4-6", "sonnet"]);
    for (const e of entries) {
      expect(e.object).toBe("model");
      expect(e.owned_by).toBe("artagon-agent-cli-plugin (claude)");
      expect(typeof e.created).toBe("number");
    }
  });

  test("no aliases: only canonical entry", () => {
    const entries = toOpenAiModelEntries({
      id: "gpt-5.5",
      backend: BACKEND_NAMES.CODEX,
      aliases: [],
      is_default: true,
      owned_by: "artagon-agent-cli-plugin (codex)"
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("gpt-5.5");
  });
});
