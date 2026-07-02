/**
 * Security & RLS regression coverage for the upload feature.
 *
 * §7.1 Gate is server-enforced (not bypassable).
 * §7.2 Token redeem-style checks (valid/wrong/tampered cookie).
 * §7.3 No secret in URL / log / Referer.
 * §7.4 Rate-limited password path (real 429 via dedicated forged x-forwarded-for).
 * §7.5 RLS isolation regression.
 * §7.6 Contract unbroken (slug/shareUrl/ownerUrl/expiresAt shapes).
 *
 * API-level style (raw request contexts, status-code assertions).
 * Mirrors security-pat.spec.ts style.
 */

import path from "path";
import fs from "fs";
import { test, expect } from "@playwright/test";
import { unlockGate, seedDocument, EARLY_ACCESS_PASSWORD } from "./_helpers";

// ---------------------------------------------------------------------------
// XFF IP cleanup helper
// ---------------------------------------------------------------------------

/**
 * Delete auth_attempts rows for a specific IP (the XFF test IPs used in §7.4).
 * This makes §7.4 tests rerunnable: rows from a prior run are cleared before each test.
 *
 * Reads env vars from .env.local if not already set (security spec runs in a worker
 * that may not have loaded Next.js env).
 */
async function deleteRateLimitRowsForIp(ip: string): Promise<void> {
  // Load .env.local if NEXT_PUBLIC_SUPABASE_URL is not set.
  if (!process.env["NEXT_PUBLIC_SUPABASE_URL"]) {
    const envFile = path.join(process.cwd(), ".env.local");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceKey) {
    throw new Error("deleteRateLimitRowsForIp: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.");
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/auth_attempts?ip=eq.${encodeURIComponent(ip)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`deleteRateLimitRowsForIp: DELETE for ip=${ip} failed (${res.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// §7.1 Gate is server-enforced
// ---------------------------------------------------------------------------

test("§7.1a cookie-less POST /api/documents returns 403 'Upload is locked'", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    const res = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "Probe", content: "# Hello", password: "test-password" },
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Upload is locked");
  } finally {
    await ctx.dispose();
  }
});

test("§7.1b after unlockGate the same context can POST /api/documents → 201", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    await unlockGate(ctx);
    const res = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "Unlocked", content: "# Hello\n\nworld.", password: "test-password" },
    });
    expect(res.status(), await res.text()).toBe(201);
  } finally {
    await ctx.dispose();
  }
});

// ---------------------------------------------------------------------------
// §7.2 Cookie matrix (valid / wrong / tampered)
// ---------------------------------------------------------------------------

test("§7.2a valid password → 200 ok=true + cookie; follow-up create → 201", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    const gateRes = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: EARLY_ACCESS_PASSWORD },
    });
    expect(gateRes.status()).toBe(200);
    const gateBody = (await gateRes.json()) as { ok: boolean };
    expect(gateBody.ok).toBe(true);

    // Follow-up create succeeds.
    const createRes = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "After gate", content: "# x\n\nHello.", password: "test-password" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
  } finally {
    await ctx.dispose();
  }
});

test("§7.2b wrong password → 401 + no cookie → follow-up create still 403", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    const gateRes = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: "definitely-wrong" },
    });
    expect(gateRes.status()).toBe(401);
    const body = (await gateRes.json()) as { error: string };
    expect(body.error).toBe("Wrong password");
    // Response body never contains the submitted password.
    const rawText = await gateRes.text().catch(() => JSON.stringify(body));
    expect(rawText).not.toContain("definitely-wrong");

    // Follow-up create still gated (no cookie set).
    const createRes = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "No gate", content: "# x\n\nHello.", password: "test-password" },
    });
    expect(createRes.status()).toBe(403);
  } finally {
    await ctx.dispose();
  }
});

test("§7.2c tampered/garbage md_early_access cookie → 403 (fail-closed verify)", async ({
  playwright,
}) => {
  // A context that carries a garbage cookie value.
  const ctx = await playwright.request.newContext({
    extraHTTPHeaders: {
      Cookie: "md_early_access=garbage-not-a-valid-jwt",
    },
  });
  try {
    const res = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "Tampered", content: "# x\n\nHello.", password: "test-password" },
    });
    expect(res.status()).toBe(403);
  } finally {
    await ctx.dispose();
  }
});

// ---------------------------------------------------------------------------
// §7.3 No secret in URL / Referer
// ---------------------------------------------------------------------------

test("§7.3 Referrer-Policy: no-referrer on /api/early-access; password not in URL", async ({
  playwright,
  page,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    const res = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: EARLY_ACCESS_PASSWORD },
    });
    // Referrer-Policy header present.
    const headers = res.headers();
    expect(headers["referrer-policy"]).toBe("no-referrer");

    // Response body does not echo the password.
    const rawText = await res.text();
    expect(rawText).not.toContain(EARLY_ACCESS_PASSWORD);
  } finally {
    await ctx.dispose();
  }

  // The page-level request to /api/early-access must not have the password in the URL.
  const requestUrls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("early-access")) {
      requestUrls.push(req.url());
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Upload a file" }).click();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({ timeout: 10_000 });

  for (const url of requestUrls) {
    expect(url).not.toContain(EARLY_ACCESS_PASSWORD);
    expect(url).not.toContain("password=");
  }
});

test("§7.3 After full create, page.url() and both returned URLs contain no token in query", async ({
  page,
}) => {
  // Reset rate limits before this test — the suite runs many unlocks before reaching
  // this test and may exhaust the early_access bucket on the shared loopback IP.
  const { resetRateLimits } = await import("./_helpers");
  await resetRateLimits();

  await page.goto("/");
  await page.getByRole("button", { name: "Upload a file" }).click();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({ timeout: 10_000 });

  // Pick a file and upload.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles({ name: "test.md", mimeType: "text/markdown", buffer: Buffer.from("# Test\n\nHello.") });
  await page.locator('input[autocomplete="new-password"]').fill("test-password");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

  // page.url() has no query token.
  const currentUrl = page.url();
  expect(new URL(currentUrl).search).toBe("");
  expect(currentUrl).not.toContain(EARLY_ACCESS_PASSWORD);

  // Both returned URLs have tokens only in fragment.
  const ownerVal = await page.getByRole("textbox", { name: "Owner link URL" }).inputValue();
  const reviewerVal = await page.getByRole("textbox", { name: "Reviewer link URL" }).inputValue();
  expect(new URL(ownerVal).search).toBe("");
  expect(new URL(reviewerVal).search).toBe("");
  // Token appears only after #.
  expect(ownerVal.indexOf("o=")).toBeGreaterThan(ownerVal.indexOf("#"));
  expect(reviewerVal.indexOf("t=")).toBeGreaterThan(reviewerVal.indexOf("#"));
});

// ---------------------------------------------------------------------------
// §7.4 Real rate-limit 429 via dedicated forged x-forwarded-for
// ---------------------------------------------------------------------------

test("§7.4 11th early_access attempt from a dedicated XFF IP returns 429", async ({
  playwright,
}) => {
  // Use a unique test IP in the TEST-NET-3 (documentation) range so it can never
  // be a real user or the shared 0.0.0.0 bucket. This IP gets its own bucket.
  const testIp = "203.0.113.41";
  // Clear any leftover rows from a prior run to make this test rerunnable.
  await deleteRateLimitRowsForIp(testIp);

  const ctx = await playwright.request.newContext({
    extraHTTPHeaders: { "x-forwarded-for": testIp },
  });
  try {
    // The limit is 10 (strictly > 10 → 429). The check happens BEFORE the password
    // compare, so wrong password is fine — it still burns the budget.
    for (let i = 0; i < 10; i++) {
      await ctx.post("http://localhost:3000/api/early-access", {
        data: { password: "wrong-intentionally" },
      });
    }

    // 11th attempt.
    const res = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: "wrong-intentionally" },
    });
    expect(res.status()).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Too many attempts");
  } finally {
    await ctx.dispose();
  }
});

test("§7.4 21st upload attempt from a dedicated XFF IP returns 429 'Too many uploads'", async ({
  playwright,
}) => {
  // Different IP from the early-access test — own independent bucket.
  const testIp = "203.0.113.42";
  // Clear any leftover rows from a prior run to make this test rerunnable.
  await deleteRateLimitRowsForIp(testIp);

  const ctx = await playwright.request.newContext({
    extraHTTPHeaders: { "x-forwarded-for": testIp },
  });
  try {
    // First, unlock the gate on this IP.
    const gateRes = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: EARLY_ACCESS_PASSWORD },
    });
    expect(gateRes.status()).toBe(200);

    // Upload 20 documents (the limit is strictly > 20, so the 20th is allowed).
    for (let i = 0; i < 20; i++) {
      const r = await ctx.post("http://localhost:3000/api/documents", {
        data: {
          title: `Rate limit test ${i}`,
          content: `# Doc ${i}\n\nContent.`,
          password: "test-password",
        },
      });
      // All 20 should succeed (201).
      expect(r.status(), `attempt ${i} failed: ${await r.text()}`).toBe(201);
    }

    // 21st attempt should 429.
    const res = await ctx.post("http://localhost:3000/api/documents", {
      data: { title: "Over limit", content: "# Over\n\nContent.", password: "test-password" },
    });
    expect(res.status()).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Too many uploads");
  } finally {
    await ctx.dispose();
  }
}, { timeout: 60_000 }); // Extended timeout for 20 sequential creates.

// ---------------------------------------------------------------------------
// §7.5 RLS isolation regression
// ---------------------------------------------------------------------------

test("§7.5 PAT minted for doc A is 403 on doc B (isolation unbroken after gate)", async ({
  page,
  playwright,
}) => {
  // Create doc A.
  const docA = await seedDocument(page.request, { title: "RLS Doc A" });
  // Redeem owner session on A.
  const ownerPathA = docA.ownerUrl.slice(docA.ownerUrl.indexOf("/d/"));
  await page.goto(ownerPathA);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill("Owner A");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible({ timeout: 10_000 });

  // Mint a PAT for doc A.
  const mint = await page.request.post(`/api/d/${docA.slug}/pat`, {
    data: { name: "cli-rls", scopes: ["docs:read"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token } = (await mint.json()) as { token: string };
  expect(token).toMatch(/^pat_/);

  // Create doc B via a fresh context (own gate unlock).
  const docB = await seedDocument(page.request, { title: "RLS Doc B" });

  // A cookie-less client wielding the PAT for A is 403 on B.
  const api = await playwright.request.newContext();
  try {
    const port = process.env["PORT"] ?? "3000";
    const onB = await api.get(`http://localhost:${port}/api/d/${docB.slug}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(onB.status()).toBe(403);
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// §7.6 Contract unbroken
// ---------------------------------------------------------------------------

test("§7.6 seedDocument returns slug, shareUrl (#t=), ownerUrl (#o=), expiresAt", async ({
  page,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Contract Test",
    content: "# Contract\n\nVerify the payload shape.",
    password: "test-password",
  });

  // slug is a non-empty string.
  expect(doc.slug).toBeTruthy();
  expect(typeof doc.slug).toBe("string");

  // shareUrl contains #t= in the fragment.
  expect(doc.shareUrl).toContain("#t=");
  expect(new URL(doc.shareUrl).search).toBe("");
  const tIdx = doc.shareUrl.indexOf("#t=");
  const tToken = doc.shareUrl.slice(tIdx + 3);
  expect(tToken.length).toBeGreaterThan(0);

  // ownerUrl contains #o= in the fragment.
  expect(doc.ownerUrl).toContain("#o=");
  expect(new URL(doc.ownerUrl).search).toBe("");
  const oIdx = doc.ownerUrl.indexOf("#o=");
  const oToken = doc.ownerUrl.slice(oIdx + 3);
  expect(oToken.length).toBeGreaterThan(0);

  // expiresAt is a valid ISO date string approx 30 days from now.
  expect(doc.expiresAt).toBeTruthy();
  const expiresDate = new Date(doc.expiresAt);
  expect(isNaN(expiresDate.getTime())).toBe(false);
  const nowPlus29Days = Date.now() + 29 * 24 * 60 * 60 * 1000;
  const nowPlus31Days = Date.now() + 31 * 24 * 60 * 60 * 1000;
  expect(expiresDate.getTime()).toBeGreaterThan(nowPlus29Days);
  expect(expiresDate.getTime()).toBeLessThan(nowPlus31Days);
});

test("§7.6 Cache-Control: no-store on /api/early-access responses", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    // 200 response.
    const ok = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: EARLY_ACCESS_PASSWORD },
    });
    expect(ok.headers()["cache-control"]).toContain("no-store");

    // 401 response.
    const bad = await ctx.post("http://localhost:3000/api/early-access", {
      data: { password: "wrong" },
    });
    expect(bad.headers()["cache-control"]).toContain("no-store");
  } finally {
    await ctx.dispose();
  }
});
