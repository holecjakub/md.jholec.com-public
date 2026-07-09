import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path alias so modules that import via "@/…"
    // (e.g. lib/comments/*) are unit-testable.
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    // Playwright specs live in e2e/ and run via `pnpm e2e`, not Vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
