import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
    maxWorkers: "50%",
    // Settings/workspace fixtures are read from disk rather than imported.
    forceRerunTriggers: ["**/fixtures/**", "**/scripts/validation/**", "**/package.json", "**/package-lock.json", "**/vitest.config.*"],
  },
  oxc: { jsx: { runtime: "automatic" } },
});
