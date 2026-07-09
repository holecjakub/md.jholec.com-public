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
  // Retry in CI only: with the wholesale mobile failure fixed the suite is fast
  // again (≈270 green), so 2 retries fit well inside the 60-min job budget and
  // absorb the occasional load-timing flake. Locally (retries 0) a failure is real.
  retries: process.env.CI ? 2 : 0,
  fullyParallel: true,
  // Per-test and expect() headroom for the long, single-worker (serial) CI run:
  // under WebKit-on-Linux load a legitimately-correct wait can take longer than
  // the local default. This only extends how long a correct wait MAY take; it
  // changes no assertion semantics. Local timeouts stay tight so a real
  // regression still fails fast.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 10_000 : 5_000 },
  webServer: {
    // On CI, serve a PRODUCTION build (`next start`) instead of `next dev`. The
    // dev server (on-demand route compilation + HMR + growing memory) degrades
    // over the ~29-min, workers:1 serial WebKit run and starts dropping sockets
    // (ECONNRESET) and missing visibility deadlines; WebKit-on-Linux surfaces the
    // slow/aborted same-origin fetches as "access control checks" console noise.
    // A prod server precompiles every route and has no watcher, so it stays stable.
    // ci.yml runs `pnpm --filter @md/web build` first, so this only boots the
    // server (fast, within the 120s timeout). Local keeps `next dev` for DX.
    // E2E_TRUST_XRI lets the prod-build server honor the suite's forged x-real-ip
    // for rate-limit bucket isolation (see lib/auth/rate-limit.ts); test-only.
    command: process.env.CI ? `PORT=${PORT} E2E_TRUST_XRI=1 pnpm start` : "NODE_ENV=development pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL,
    // CI-only action/navigation headroom (0 = library default locally). Same
    // rationale as `timeout`/`expect` above: extend correct waits under CI load
    // without changing what is being asserted.
    actionTimeout: process.env.CI ? 15_000 : 0,
    navigationTimeout: process.env.CI ? 30_000 : 0,
    // Diagnostics for the WebKit-on-Linux CI failures: capture a trace on the
    // first retry (+ screenshot/video on failure) so the ci.yml artifact upload
    // has the network/timeline to confirm whether a residual failure is a dropped
    // fetch vs a real bug — without slowing the happy path.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
});
