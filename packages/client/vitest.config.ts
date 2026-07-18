import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test-setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    passWithNoTests: true,
    maxWorkers: 3,
    minWorkers: 1,
    // Deploy shells export NODE_ENV=production, which makes React/testing-
    // library load prod bundles (React.act missing). Tests always run in
    // test mode regardless of the invoking shell.
    env: { NODE_ENV: "test" },
  },
});
