import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    exclude: ["node_modules/**", "dist/**"],
    passWithNoTests: true,
    maxWorkers: 4,
    minWorkers: 1,
    // Deploy shells export NODE_ENV=production; tests must not inherit it.
    env: { NODE_ENV: "test" },
    // Scrub deployment/agent-session env leakage before test modules load.
    setupFiles: ["./test/setup-env.ts"],
  },
});
