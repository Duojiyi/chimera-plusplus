import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Only the repository's own tests: local QA backups, audit output and
    // design files can hold stale copies of them.
    include: ["tests/**/*.{test,spec}.{ts,tsx}", "src/**/*.{test,spec}.{ts,tsx}"],
    // Release guard tests use node:test and run separately in CI.
    exclude: [
      ...configDefaults.exclude,
      "scripts/**/*.test.mjs",
      ".qa/**",
      ".agents/**",
      "artifacts/**",
      "designs/**",
    ],
    // The two whole-application suites render the full shell; give them room
    // on a loaded machine.
    testTimeout: 15000,
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
