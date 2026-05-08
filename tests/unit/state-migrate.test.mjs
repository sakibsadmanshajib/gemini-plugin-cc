/**
 * Unit tests for the state-schema migrator.
 *
 * Pins the v1 → v2 contract: detect, migrate, idempotent, field-preserving.
 */

import { expect, test } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  defaultStateV2,
  detectSchemaVersion,
  migrate
} from "#lib/state/migrate.mjs";

test("detectSchemaVersion: recognizes v1 (version: 1)", () => {
  expect(detectSchemaVersion({ version: 1 })).toBe("v1");
  expect(detectSchemaVersion({ version: 1, config: {}, jobs: [] })).toBe("v1");
});

test("detectSchemaVersion: recognizes v2 (schemaVersion: '2')", () => {
  expect(detectSchemaVersion({ schemaVersion: "2" })).toBe("v2");
});

test("detectSchemaVersion: unknown for null, primitives, and unversioned objects", () => {
  expect(detectSchemaVersion(null)).toBe("unknown");
  expect(detectSchemaVersion(undefined)).toBe("unknown");
  expect(detectSchemaVersion(42)).toBe("unknown");
  expect(detectSchemaVersion("v1")).toBe("unknown");
  expect(detectSchemaVersion({})).toBe("unknown");
  expect(detectSchemaVersion({ version: 99 })).toBe("unknown");
  expect(detectSchemaVersion({ schemaVersion: "999" })).toBe("unknown");
});

test("migrate: v1 → v2 strips version, adds schemaVersion, preserves all other fields", () => {
  const v1 = {
    version: 1,
    config: { stopReviewGate: true, custom: "preserved" },
    jobs: [{ id: "j1", status: "completed" }]
  };
  const v2 = migrate(v1);
  expect(v2.schemaVersion).toBe("2");
  expect("version" in v2).toBe(false);
  expect(v2.config).toEqual({ stopReviewGate: true, custom: "preserved" });
  expect(v2.jobs).toEqual([{ id: "j1", status: "completed" }]);
});

test("migrate: v2 → v2 is idempotent (no shape change)", () => {
  const v2 = {
    schemaVersion: "2",
    config: { stopReviewGate: false },
    jobs: []
  };
  expect(migrate(v2)).toEqual(v2);
});

test("migrate: throws on unknown version", () => {
  expect(() => migrate({ version: 999 })).toThrow(/unrecognized state schema/i);
  expect(() => migrate(null)).toThrow(/unrecognized state schema/i);
  expect(() => migrate({})).toThrow(/unrecognized state schema/i);
});

test("migrate: preserves additional v1 fields not declared in the typedef", () => {
  // Real v1 state files carry fields beyond {version, config, jobs} (e.g.,
  // a future migration might have temporarily added a flag). Migrate is
  // field-additive — anything we don't recognize MUST survive the round-trip.
  const v1WithExtra = {
    version: 1,
    config: {},
    jobs: [],
    futureFlag: { foo: "bar" },
    arbitrary: [1, 2, 3]
  };
  const v2 = migrate(v1WithExtra);
  expect(v2.futureFlag).toEqual({ foo: "bar" });
  expect(v2.arbitrary).toEqual([1, 2, 3]);
});

test("defaultStateV2: matches the canonical empty v2 shape", () => {
  const def = defaultStateV2();
  expect(def).toEqual({
    schemaVersion: LATEST_SCHEMA_VERSION,
    config: { stopReviewGate: false },
    jobs: []
  });
});

test("v1 default → migrate → v2 default has equivalent semantics", () => {
  // The legacy runtime's defaultState() at plugins/gemini/scripts/lib/state.mjs:46
  // returns { version: 1, config: { stopReviewGate: false }, jobs: [] }.
  // Migrating it must produce a v2 default that matches defaultStateV2().
  const legacyDefault = {
    version: 1,
    config: { stopReviewGate: false },
    jobs: []
  };
  expect(migrate(legacyDefault)).toEqual(defaultStateV2());
});
