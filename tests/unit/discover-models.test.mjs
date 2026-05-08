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

  test("includes the three canonical claude ids", () => {
    const ids = models.map((m) => m.id).sort();
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-haiku-4-5");
  });

  test("aliases collected against canonical ids", () => {
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet?.aliases).toEqual(["sonnet"]);
    const opus = models.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.aliases).toEqual(["opus"]);
  });

  test("default model flagged + sorted first", () => {
    expect(models[0].is_default).toBe(true);
    // Claude default is "sonnet" → resolves to claude-sonnet-4-6.
    expect(models[0].id).toBe("claude-sonnet-4-6");
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

  test("includes spark, gpt-5, gpt-5-codex, o3, o3-mini, o4-mini", () => {
    const ids = models.map((m) => m.id);
    for (const expected of ["spark", "gpt-5", "gpt-5-codex", "o3", "o3-mini", "o4-mini"]) {
      expect(ids).toContain(expected);
    }
  });

  test("default is spark", () => {
    expect(models[0].is_default).toBe(true);
    expect(models[0].id).toBe("spark");
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
      id: "spark",
      backend: BACKEND_NAMES.CODEX,
      aliases: [],
      is_default: true,
      owned_by: "artagon-agent-cli-plugin (codex)"
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("spark");
  });
});
