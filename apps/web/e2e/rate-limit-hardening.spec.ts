/**
 * Rate-limit hardening coverage for the security-audit fixes.
 *
 * The /redeem path (mints an owner/reviewer session) gained a dedicated per-IP
 * `redeem` limiter (20/15min), applied BEFORE the token lookup — mirroring the
 * `export` limiter already covered in agent-export.spec §4. We forge a dedicated
 * TEST-NET-3 IP so this test owns its bucket and never pollutes other specs.
 *
 * The comment/reply/react write limiter (`write`, 60/15min) and the /versions
 * size cap (413) reuse the identical, already-tested isIpRateLimited mechanism and
 * documents-route byte cap, so they are not re-exercised end-to-end here.
 */

import { test, expect } from "@playwright/test";
import { deleteRateLimitRowsForIp } from "./_helpers";

const PORT = process.env["PORT"] ?? "3000";
const BASE = `http://localhost:${PORT}`;

test(
  "redeem rate-limit: 21st POST /api/d/<slug>/redeem from a dedicated IP returns 429",
  async ({ playwright }, testInfo) => {
    // Distinct TEST-NET-3 IPs per project so desktop/mobile never share a bucket.
    const testIp = testInfo.project.name === "mobile" ? "203.0.113.211" : "203.0.113.210";
    await deleteRateLimitRowsForIp(testIp);

    // The limiter runs before the doc/token lookup, so a dummy slug suffices:
    // requests 1-20 fall through to 404/401; request 21 trips the limit → 429.
    const dummySlug = "redeem-rate-limit-slug-not-exist";
    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { "x-real-ip": testIp },
    });
    try {
      for (let i = 0; i < 20; i++) {
        const res = await ctx.post(`${BASE}/api/d/${dummySlug}/redeem`, {
          data: { token: "pat_dummy_redeem_token", name: "Rate Limit Tester" },
        });
        expect(res.status(), `attempt ${i + 1} should not be 429 yet`).not.toBe(429);
      }
      const limited = await ctx.post(`${BASE}/api/d/${dummySlug}/redeem`, {
        data: { token: "pat_dummy_redeem_token", name: "Rate Limit Tester" },
      });
      expect(limited.status()).toBe(429);
      const body = (await limited.json()) as { error: string };
      expect(body.error).toBe("Too many requests");
    } finally {
      await ctx.dispose();
    }
  },
  { timeout: 60_000 },
);
