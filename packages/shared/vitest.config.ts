import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Deploy shells export NODE_ENV=production; tests must not inherit it.
    env: { NODE_ENV: "test" },
  },
});
