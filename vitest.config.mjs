import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.mjs",
      "tests/integration/**/*.test.mjs",
      "tests/property/**/*.test.mjs"
    ],
    exclude: ["node_modules", ".generated", "openspec/changes/archive/**"],
    // Many integration tests stage real fs/git fixtures and network-mock
    // shims; running them serially mirrors the prior `node --test`
    // execution model and avoids fixture-collision flakes.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Plain console output. The runtime under test writes its own stderr
    // diagnostics; vitest's reporter shouldn't shadow them.
    reporters: process.env.CI ? ["default"] : ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["lib/**/*.mjs", "plugins/gemini/scripts/**/*.mjs"],
      exclude: ["tests/**", "**/*.test.mjs", "**/.generated/**", "lib/test-utils/**"]
    }
  }
});
