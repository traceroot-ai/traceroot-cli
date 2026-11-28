import { defineConfig } from "vitest/config";

/**
 * The smoke run of `evals run` against released SDKs. `npm test` runs only `*.test.ts` files, so it
 * leaves this out: installing the SDKs needs the package registries. Run it from the repository
 * root:
 *
 *   npx vitest run --config tests/smoke/evals/vitest.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/smoke/evals/*.smoke.ts"],
    globalSetup: ["tests/helpers/build.setup.ts"],
    // Each run starts a real runner, and each SDK release is installed before its runs.
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
