import { defineConfig } from "vitest/config";

// Without a local config vitest walks up to the repo root config, whose include
// list covers only apps/desktop and packages/*.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"]
  }
});
