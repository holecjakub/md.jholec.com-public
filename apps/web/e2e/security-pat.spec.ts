import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Security review C1 + C2 regression guards for Personal Access Tokens.
 *
 * C1: the mint endpoint /api/d/[slug]/pat is OWNER-gated (was unauthenticated and
 *     issued globally-privileged tokens).
 * C2: a minted PAT authorizes ONLY the document it was minted for — it must NOT
 *     grant access to any other document (was: any valid PAT = owner of all docs).
 */

const CONTENT = "# Secured Report\n\nA paragraph.\n";

async function createDoc(page: Page) {
  const doc = await seedDocument(page.request, {
    title: "Sec Doc",
    content: CONTENT,
    password: "test-password",
  });
  return { slug: doc.slug, ownerPath: doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/")) };
}

async function redeemOwner(page: Page, ownerPath: string) {
  await page.goto(ownerPath);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill("Olivia Owner");
  await page.getByRole("button", { name: "View document" }).click();
  // Wait for the DOCUMENT heading (not the gate's "Welcome" h1) so the redeem —
  // which sets the owner session cookie — has actually completed before we mint.
  await expect(
    page.getByRole("heading", { name: "Secured Report", level: 1 }),
  ).toBeVisible();
}

test("PAT mint endpoint rejects unauthenticated callers (C1)", async ({ page }) => {
  const doc = await createDoc(page);
  // Brand-new context with NO owner session cookie.
  const res = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli", scopes: ["docs:read"] },
    // page.request here has no redeemed session for this doc.
  });
  expect([401, 403]).toContain(res.status());
  expect(res.status()).not.toBe(201);
});

test("PAT mint rejects scopes outside the allow-list (C1)", async ({ page }) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);
  const res = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli", scopes: ["docs:read", "admin:everything"] },
  });
  expect(res.status()).toBe(400);
});

test("an owner-minted PAT authorizes ONLY its own document (C2)", async ({
  page,
  playwright,
}) => {
  // Owner creates + redeems two documents.
  const docA = await createDoc(page);
  await redeemOwner(page, docA.ownerPath);
  // Mint a PAT for doc A (owner session present on page.request).
  const mint = await page.request.post(`/api/d/${docA.slug}/pat`, {
    data: { name: "cli-a", scopes: ["docs:read"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token } = (await mint.json()) as { token: string };
  expect(token).toMatch(/^pat_/);

  const docB = await createDoc(page);

  // A cookie-less client wielding only the PAT:
  const api: APIRequestContext = await playwright.request.newContext();
  // → can read its own document (doc A).
  const onA = await api.get(`http://localhost:${process.env.PORT ?? 3000}/api/d/${docA.slug}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(onA.status()).toBe(200);
  // → is FORBIDDEN on a different document (doc B) — the core C2 guarantee.
  const onB = await api.get(`http://localhost:${process.env.PORT ?? 3000}/api/d/${docB.slug}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(onB.status()).toBe(403);
  await api.dispose();
});
