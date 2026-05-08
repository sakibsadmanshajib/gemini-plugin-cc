/**
 * State-file schema migration.
 *
 * The legacy `plugins/gemini/scripts/lib/state.mjs` writes
 * `{ version: 1, config, jobs }` (the gemini-plugin-baseline `State Layout`
 * requirement at commit `f8f773c`). The v2 transport-abstraction runtime
 * writes `{ schemaVersion: "2", config, jobs, … }` with the same field set
 * plus future-extension headroom. Both formats can be on disk simultaneously
 * during the transition.
 *
 * `migrate(state)` reads any known version and returns the latest. v1 → v2
 * is **field-additive only**: every field a v1 state had is preserved
 * verbatim under v2. Removing a field requires v3 and an explicit
 * deprecation cycle.
 *
 * Forward-compatibility: this module is consumed by the v2 runtime's
 * state reader. The legacy runtime is unchanged (it still reads/writes v1).
 * When a v2 reader encounters a v1 file, it migrates in-memory and never
 * persists v2 back unless the caller explicitly does so.
 */

const LATEST_SCHEMA_VERSION = "2";

/**
 * @typedef {object} StateV1
 * @property {1} version
 * @property {object} [config]
 * @property {Array<object>} [jobs]
 *
 * @typedef {object} StateV2
 * @property {"2"} schemaVersion
 * @property {object} [config]
 * @property {Array<object>} [jobs]
 */

/**
 * Detect the schema version of a parsed state object.
 *
 * @param {unknown} state
 * @returns {"v1" | "v2" | "unknown"}
 */
export function detectSchemaVersion(state) {
  if (!state || typeof state !== "object") return "unknown";
  const s = /** @type {Record<string, unknown>} */ (state);
  if (s.schemaVersion === "2") return "v2";
  if (s.version === 1) return "v1";
  return "unknown";
}

/**
 * Migrate a parsed state object to the latest schema. Idempotent: passing a
 * v2 state returns it unchanged.
 *
 * Throws when the input is not a recognized version. Callers that want
 * "tolerate broken files" semantics should wrap in try/catch and fall back
 * to a fresh default state — matches the legacy reader at
 * `plugins/gemini/scripts/lib/state.mjs::loadState`.
 *
 * @param {unknown} state
 * @returns {StateV2}
 */
export function migrate(state) {
  const version = detectSchemaVersion(state);
  if (version === "unknown") {
    throw new Error(
      `Unrecognized state schema (expected version: 1 or schemaVersion: "2"): ${JSON.stringify(state)?.slice(0, 200)}`
    );
  }

  const s = /** @type {Record<string, unknown>} */ (state);
  if (version === "v2") {
    return /** @type {StateV2} */ (s);
  }

  // v1 → v2: drop `version: 1`, set `schemaVersion: "2"`, preserve all other
  // fields verbatim. Field-additive migration — no v1 field is renamed or
  // removed; v2 readers will see every v1 field plus the new schemaVersion.
  const { version: _version, ...rest } = s;
  return /** @type {StateV2} */ ({
    schemaVersion: LATEST_SCHEMA_VERSION,
    ...rest
  });
}

/**
 * Build a fresh default state in v2 format.
 *
 * @returns {StateV2}
 */
export function defaultStateV2() {
  return {
    schemaVersion: LATEST_SCHEMA_VERSION,
    config: { stopReviewGate: false },
    jobs: []
  };
}

export { LATEST_SCHEMA_VERSION };
