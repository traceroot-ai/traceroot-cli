import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/build.setup.ts"],
    testTimeout: 20000,
  },
});
