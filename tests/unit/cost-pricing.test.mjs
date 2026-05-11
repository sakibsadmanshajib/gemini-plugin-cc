/**
 * Unit tests for lib/cost/pricing.mjs.
 *
 * Coverage:
 *   - DEFAULT_PRICING shape: every backend has a default + at least one model
 *   - lookupPrice: model-prefix matching, longest-prefix wins, default fallback
 *   - estimateUsd: prompt + completion math, missing fields, unknown backend
 *   - resolvePricingTable: env override, injection, default fallback
 *   - formatUsd: cents granularity for ≥$1, mils below, NaN guard
 */

import { describe, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import {
  DEFAULT_PRICING,
  estimateUsd,
  formatUsd,
  lookupPrice,
  resolvePricingTable
} from "#lib/cost/pricing.mjs";

describe("DEFAULT_PRICING shape", () => {
  test("Every backend has a default rate", () => {
    for (const backend of Object.values(BACKEND_NAMES)) {
      expect(DEFAULT_PRICING[backend]).toBeDefined();
      expect(typeof DEFAULT_PRICING[backend].default.input_per_million).toBe("number");
      expect(typeof DEFAULT_PRICING[backend].default.output_per_million).toBe("number");
    }
  });

  test("At least one model override per backend", () => {
    for (const backend of Object.values(BACKEND_NAMES)) {
      expect(DEFAULT_PRICING[backend].models).toBeDefined();
      expect(Object.keys(DEFAULT_PRICING[backend].models ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("All rates are positive", () => {
    for (const backendKey of Object.values(BACKEND_NAMES)) {
      const row = DEFAULT_PRICING[backendKey];
      expect(row.default.input_per_million).toBeGreaterThan(0);
      expect(row.default.output_per_million).toBeGreaterThan(0);
      for (const model of Object.values(row.models ?? {})) {
        expect(model.input_per_million).toBeGreaterThan(0);
        expect(model.output_per_million).toBeGreaterThan(0);
      }
    }
  });
});

describe("lookupPrice", () => {
  test("returns the default when model is null", () => {
    const row = lookupPrice(BACKEND_NAMES.CLAUDE, null, DEFAULT_PRICING);
    expect(row).toBe(DEFAULT_PRICING[BACKEND_NAMES.CLAUDE].default);
  });

  test("returns the matching model row when prefix matches", () => {
    const row = lookupPrice(BACKEND_NAMES.CLAUDE, "claude-opus-4-5-20250928", DEFAULT_PRICING);
    expect(row).toBe(DEFAULT_PRICING[BACKEND_NAMES.CLAUDE].models?.["claude-opus"]);
  });

  test("longest-prefix wins (claude-sonnet beats claude)", () => {
    const table = {
      [BACKEND_NAMES.CLAUDE]: {
        default: { input_per_million: 99, output_per_million: 99 },
        models: {
          claude: { input_per_million: 1, output_per_million: 2 },
          "claude-sonnet": { input_per_million: 3, output_per_million: 4 }
        }
      }
    };
    const row = lookupPrice(BACKEND_NAMES.CLAUDE, "claude-sonnet-4-6", table);
    expect(row).toEqual({ input_per_million: 3, output_per_million: 4 });
  });

  test("falls back to default when no model matches", () => {
    const row = lookupPrice(BACKEND_NAMES.CLAUDE, "nonexistent-model", DEFAULT_PRICING);
    expect(row).toBe(DEFAULT_PRICING[BACKEND_NAMES.CLAUDE].default);
  });

  test("returns null for unknown backend", () => {
    const row = lookupPrice("not-a-backend", "claude-opus", DEFAULT_PRICING);
    expect(row).toBeNull();
  });
});

describe("estimateUsd", () => {
  test("Computes cost for prompt + completion at default rate", () => {
    // Sonnet default: $3/M prompt + $15/M completion.
    // 1000 prompt + 500 completion = 1000/1M*3 + 500/1M*15
    //                              = 0.003 + 0.0075 = 0.0105 USD
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      { prompt_tokens: 1000, completion_tokens: 500 },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  test("Honors a per-model rate override", () => {
    // Opus is $15/M prompt + $75/M completion.
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      "claude-opus-4-5",
      { prompt_tokens: 1000, completion_tokens: 500 },
      { table: DEFAULT_PRICING }
    );
    // 1000/1M*15 + 500/1M*75 = 0.015 + 0.0375 = 0.0525
    expect(cost).toBeCloseTo(0.0525, 6);
  });

  test("Returns 0 for unknown backend (degraded mode, never throws)", () => {
    const cost = estimateUsd(
      "totally-unknown",
      null,
      { prompt_tokens: 1000, completion_tokens: 500 },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBe(0);
  });

  test("Treats missing usage fields as zero", () => {
    const cost = estimateUsd(BACKEND_NAMES.CLAUDE, null, {}, { table: DEFAULT_PRICING });
    expect(cost).toBe(0);
  });

  test("Coerces non-numeric usage to zero rather than NaN", () => {
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      /** @type {any} */ ({ prompt_tokens: "garbage", completion_tokens: 100 }),
      { table: DEFAULT_PRICING }
    );
    // garbage→NaN→0 prompt; 100/1M*15 completion = 0.0015
    expect(cost).toBeCloseTo(0.0015, 6);
  });

  test("Claude cache_creation tokens are charged at +25% input rate", () => {
    // Sonnet input rate $3/M. 1000 cache_creation tokens at 1.25× =
    // 1000/1M * 3 * 1.25 = 0.00375 USD.
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      { cache_creation_tokens: 1000 },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBeCloseTo(0.00375, 6);
  });

  test("Claude cache_read tokens are charged at 10% of input rate", () => {
    // 10_000 cache reads at 0.1× of $3/M = 10000/1M * 3 * 0.1 = 0.003.
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      { cache_read_tokens: 10_000 },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBeCloseTo(0.003, 6);
  });

  test("Claude all-component pricing matches sum of parts", () => {
    // Mix of regular + cache_create + cache_read + completion.
    // Sonnet $3/M input, $15/M output.
    //   regular:    1000/1M * 3            = 0.003
    //   create:     1000/1M * 3 * 1.25     = 0.00375
    //   read:      10000/1M * 3 * 0.10     = 0.003
    //   output:     500/1M * 15            = 0.0075
    //   total                              = 0.01725
    const cost = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_creation_tokens: 1000,
        cache_read_tokens: 10_000
      },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBeCloseTo(0.01725, 6);
  });

  test("OpenAI cache_read is subtracted from prompt_tokens (subset semantics)", () => {
    // For codex/GPT-4o+, cached_tokens is a SUBSET of prompt_tokens.
    // Charge: regular = (prompt - cache_read), cache_read at 50% input.
    // GPT-5 default: $1.25/M input, $10/M output.
    //   prompt 1000 (incl 600 cached)
    //     regular = 400/1M * 1.25     = 0.0005
    //     cached  = 600/1M * 1.25 * 0.5 = 0.000375
    //   completion 100 = 100/1M * 10  = 0.001
    //   total                         = 0.001875
    const cost = estimateUsd(
      BACKEND_NAMES.CODEX,
      null,
      {
        prompt_tokens: 1000,
        completion_tokens: 100,
        cache_read_tokens: 600
      },
      { table: DEFAULT_PRICING }
    );
    expect(cost).toBeCloseTo(0.001875, 6);
  });

  test("Cached input is cheaper than uncached for the same Claude turn", () => {
    // Sanity: 100k input tokens, 0 cache vs 100k of cache reads.
    const noCache = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      { prompt_tokens: 100_000, completion_tokens: 0 },
      { table: DEFAULT_PRICING }
    );
    const allCache = estimateUsd(
      BACKEND_NAMES.CLAUDE,
      null,
      { prompt_tokens: 0, cache_read_tokens: 100_000, completion_tokens: 0 },
      { table: DEFAULT_PRICING }
    );
    // Claude cache reads are 10% of input; allCache should be exactly
    // 1/10 of noCache.
    expect(allCache).toBeCloseTo(noCache * 0.1, 6);
  });
});

describe("resolvePricingTable", () => {
  test("Direct table injection wins", () => {
    const stub = {
      foo: { default: { input_per_million: 1, output_per_million: 2 } }
    };
    expect(resolvePricingTable({ table: stub })).toBe(stub);
  });

  test("context.cost.pricingOverride JSON is parsed and used", () => {
    const stub = {
      foo: { default: { input_per_million: 7, output_per_million: 8 } }
    };
    const context = /** @type {any} */ ({
      cost: { pricingOverride: JSON.stringify(stub) }
    });
    expect(resolvePricingTable({ context })).toEqual(stub);
  });

  test("Bad JSON in context.cost.pricingOverride falls back to default (no throw)", () => {
    const context = /** @type {any} */ ({
      cost: { pricingOverride: "{not json" }
    });
    expect(resolvePricingTable({ context })).toBe(DEFAULT_PRICING);
  });

  test("No context / no pricingOverride returns DEFAULT_PRICING", () => {
    expect(resolvePricingTable()).toBe(DEFAULT_PRICING);
    expect(resolvePricingTable({})).toBe(DEFAULT_PRICING);
  });

  test("ARTAGON_PRICING_OVERRIDE env is NO LONGER read by lib (Phase 4)", () => {
    // Legacy env var: lib reads only from context now. Without a
    // context override, the env-only call returns the default table.
    expect(resolvePricingTable({ env: { ARTAGON_PRICING_OVERRIDE: '{"foo":{}}' } })).toBe(
      DEFAULT_PRICING
    );
  });
});

describe("formatUsd", () => {
  test("Cents granularity at $1+", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(99.999)).toBe("$100.00");
  });

  test("Mils granularity for $0.01-$0.99", () => {
    expect(formatUsd(0.0123)).toBe("$0.012");
    expect(formatUsd(0.5)).toBe("$0.500");
  });

  test("4-decimal granularity below $0.01", () => {
    expect(formatUsd(0.001234)).toBe("$0.0012");
  });

  test("Zero formats as $0.0000", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  test("NaN safely returns $?", () => {
    expect(formatUsd(Number.NaN)).toBe("$?");
  });
});
