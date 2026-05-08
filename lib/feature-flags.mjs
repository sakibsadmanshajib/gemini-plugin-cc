/**
 * Feature-flag plumbing for the multi-backend roadmap.
 *
 * The `ACP_PLUGIN_VERSION` environment variable opts into version-gated
 * behavior introduced by post-modernize-toolchain changes:
 *
 *   - `v1` (default) — current behavior captured by the
 *     `gemini-plugin-baseline` capability at commit f8f773c.
 *   - `v2` — opt-in behavior introduced by subsequent changes (transport
 *     abstraction, middleware chain, marketplace split, etc.).
 *
 * No v2 behavior ships in this change. The flag is plumbed but inert until
 * later changes consume `getPluginVersion()` to switch behavior.
 *
 * See `docs/feature-flags.md` for the full lifecycle.
 */

/**
 * Supported plugin-version values.
 *
 * @typedef {"v1" | "v2"} PluginVersion
 */

const ENV_VAR = "ACP_PLUGIN_VERSION";
const DEFAULT_VERSION = /** @type {PluginVersion} */ ("v1");
const VALID_VERSIONS = /** @type {ReadonlySet<PluginVersion>} */ (new Set(["v1", "v2"]));

/**
 * Resolve the active plugin version from the environment.
 *
 * Unknown values fall back to the default with a one-shot stderr warning so
 * misconfigurations surface during development without crashing the runtime.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read from (defaults to `process.env`)
 * @returns {PluginVersion}
 */
export function getPluginVersion(env = process.env) {
  const raw = env[ENV_VAR];
  if (raw == null || raw === "") {
    return DEFAULT_VERSION;
  }
  if (VALID_VERSIONS.has(/** @type {PluginVersion} */ (raw))) {
    return /** @type {PluginVersion} */ (raw);
  }
  process.stderr.write(
    `[feature-flags] Unknown ${ENV_VAR}=${JSON.stringify(raw)}; falling back to ${DEFAULT_VERSION}.\n`
  );
  return DEFAULT_VERSION;
}

/**
 * Lower-cardinality predicate for code paths that gate on v2.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isV2(env = process.env) {
  return getPluginVersion(env) === "v2";
}
