import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Load apps/web/.env.local into the test-runner process so secrets (e.g.
// EARLY_ACCESS_PASSWORD) never need to live in committed source. The webServer
// already gets these via Next; this mirrors them to the runner. On CI the vars
// are set directly, so a missing .env.local is fine. cwd is the package dir
// (apps/web) for both `pnpm exec` and `pnpm --filter @md/web exec`.
try {
  const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {
  // .env.local is optional (CI provides env directly).
}

// Port-flexible so isolated worktrees can each run their own dev server + QA on a
// distinct port (set PORT). Next dev reads PORT; baseURL/webServer follow it.
const PORT = process.env.PORT ?? "3000";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/globalSetup",
  // 1 worker (serial) is required to prevent shared-IP rate-limit exhaustion.
  // The suite runs many early_access and upload API calls that share the same
  // loopback IP (::1/0.0.0.0) in local Supabase; parallel workers race on the
  // 10/15min and 20/15min buckets. Serial execution is safe and rerunnable.
  // On CI, set PLAYWRIGHT_WORKERS=N to override if you use isolated Supabase instances.
  workers: process.env["PLAYWRIGHT_WORKERS"] ? parseInt(process.env["PLAYWRIGHT_WORKERS"], 10) : 1,
  fullyParallel: true,
  webServer: {
    command: "NODE_ENV=development pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: { baseURL },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
});
