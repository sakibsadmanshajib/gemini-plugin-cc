/**
 * Stryker mutation testing config.
 *
 * Targets `lib/**` (the shared shell that's becoming the multi-backend
 * runtime; small surface today, growing with the architecture roadmap).
 * Plugin-internal `plugins/gemini/scripts/` is intentionally NOT mutated
 * here — its size dwarfs `lib/` 30x and would explode mutation runtime.
 * If/when the broker/transport split moves logic into `lib/`, mutation
 * coverage extends with it naturally.
 *
 * Test-utils are excluded from the mutated set (they ARE the test infra).
 */

/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  packageManager: "pnpm",
  reporters: ["progress", "clear-text", "html"],
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.mjs"
  },
  // Mutation surface — small at modernize-toolchain landing.
  mutate: ["lib/**/*.mjs", "!lib/test-utils/**", "!**/*.test.mjs"],
  thresholds: {
    high: 80,
    low: 70,
    break: null // Don't fail CI; track score over time. Promote to 70 once baseline is established.
  },
  timeoutMS: 30000,
  // Run with concurrency=2 to stay friendly to CI runners.
  concurrency: 2,
  cleanTempDir: true
};
