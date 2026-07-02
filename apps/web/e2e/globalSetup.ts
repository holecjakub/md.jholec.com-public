/**
 * Playwright global setup — runs once before the full suite.
 *
 * Clears rate-limit rows for the shared 0.0.0.0 IP so the suite starts with a
 * clean slate regardless of how many documents prior runs created. This makes the
 * suite rerunnable: `pnpm e2e` run twice in a row must both pass.
 *
 * Safety: resetRateLimits() refuses to run against a non-localhost Supabase URL,
 * so this can never accidentally affect a real project.
 */

import path from "path";
import fs from "fs";
import { resetRateLimits } from "./_helpers";

function loadDotEnvLocal(): void {
  const envFile = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envFile)) return;

  const content = fs.readFileSync(envFile, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already set in the environment.
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export default async function globalSetup(): Promise<void> {
  // Playwright's globalSetup runs in a bare Node process that does not inherit
  // Next.js's .env.local loading — load it manually so NEXT_PUBLIC_SUPABASE_URL
  // and SUPABASE_SERVICE_ROLE_KEY are available for the rate-limit reset.
  loadDotEnvLocal();
  await resetRateLimits();
}
