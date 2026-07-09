import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Security review C1 + C2 + M1 regression guards for Personal Access Tokens.
 *
 * C1: the mint endpoint /api/d/[slug]/pat is OWNER-gated (was unauthenticated and
 *     issued globally-privileged tokens).
 * C2: a minted PAT authorizes ONLY the document it was minted for — it must NOT
 *     grant access to any other document (was: any valid PAT = owner of all docs).
 * M1: a PAT is no longer synthesized into role "owner". Credential-minting routes
 *     (/share, /pat) require TRUE owner authority: an owner cookie session, or a
 *     PAT explicitly granted the "tokens:mint" scope. Content-scoped PATs keep
 *     their content powers (download, push, resolve) but cannot mint credentials.
 * M2: revocation is real — DELETE /api/d/[slug]/pat (owner-gated like minting)
 *     sets revoked_at on every PAT bound to the document; revoked PATs die
 *     immediately. Likewise DELETE /api/d/[slug]/share revokes every live invite
 *     link — but deliberately spares owner capability tokens (kind = 'owner') so
 *     revocation can never lock the owner out of their own document.
 *     L5: CLI PATs carry a bounded expiry (returned as expiresAt).
 */

const CONTENT = "# Secured Report\n\nA paragraph.\n";

async function createDoc(page: Page) {
  const doc = await seedDocument(page.request, {
    title: "Sec Doc",
    content: CONTENT,
    password: "test-password",
  });
  return {
    slug: doc.slug,
    ownerPath: doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/")),
    // Reusable invite token minted at creation (the "#t=" URL fragment).
    inviteToken: doc.shareUrl.slice(doc.shareUrl.indexOf("#t=") + 3),
  };
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

test("a content-scoped PAT keeps content powers but cannot mint credentials (M1)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);
  // Owner mints a PAT with EVERY content scope — but not "tokens:mint".
  const mint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli", scopes: ["docs:read", "docs:write", "comments:read", "comments:write"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token } = (await mint.json()) as { token: string };

  const api: APIRequestContext = await playwright.request.newContext();
  const base = `http://localhost:${process.env.PORT ?? 3000}`;
  const headers = { authorization: `Bearer ${token}` };

  // Content authority preserved: the owner-gated raw download still works via PAT.
  const dl = await api.get(`${base}/api/d/${doc.slug}/download`, { headers });
  expect(dl.status()).toBe(200);

  // …but the PAT must NOT be able to mint further credentials.
  const patRes = await api.post(`${base}/api/d/${doc.slug}/pat`, {
    headers,
    data: { name: "escalated", kind: "export" },
  });
  expect(patRes.status()).toBe(403);
  const shareRes = await api.post(`${base}/api/d/${doc.slug}/share`, { headers });
  expect(shareRes.status()).toBe(403);
  await api.dispose();
});

test("a PAT explicitly granted tokens:mint can mint an export token (M1)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);
  // The CLI agent-link flow: a PAT with docs:write + the dedicated owner scope.
  const mint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli-owner", scopes: ["docs:write", "tokens:mint"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token } = (await mint.json()) as { token: string };

  const api: APIRequestContext = await playwright.request.newContext();
  const res = await api.post(`http://localhost:${process.env.PORT ?? 3000}/api/d/${doc.slug}/pat`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name: "AI agent (read-only)", kind: "export" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { token: exportToken } = (await res.json()) as { token: string };
  expect(exportToken).toMatch(/^pat_/);
  await api.dispose();
});

test("owner revocation kills every PAT bound to the document (M2, L5)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);
  const mint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli", scopes: ["docs:read"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token, expiresAt } = (await mint.json()) as { token: string; expiresAt: string };
  // L5: CLI PATs are no longer immortal — the mint returns a bounded expiry.
  expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

  const api: APIRequestContext = await playwright.request.newContext();
  const base = `http://localhost:${process.env.PORT ?? 3000}`;
  const headers = { authorization: `Bearer ${token}` };

  // The PAT works before revocation…
  const before = await api.get(`${base}/api/d/${doc.slug}`, { headers });
  expect(before.status()).toBe(200);

  // …and a content-scoped PAT must NOT be able to revoke credentials (M1 gate).
  const forbidden = await api.delete(`${base}/api/d/${doc.slug}/pat`, { headers });
  expect(forbidden.status()).toBe(403);

  // The owner revokes every PAT for the document (owner cookie session).
  const revoke = await page.request.delete(`/api/d/${doc.slug}/pat`);
  expect(revoke.status(), await revoke.text()).toBe(200);
  const { revoked } = (await revoke.json()) as { revoked: number };
  // At least the CLI PAT and the auto-minted agent export token.
  expect(revoked).toBeGreaterThanOrEqual(1);

  // The PAT is dead immediately after.
  const after = await api.get(`${base}/api/d/${doc.slug}`, { headers });
  expect(after.status()).toBe(401);
  await api.dispose();
});

test("invite revocation is owner-gated and spares the owner capability token (M1, M2)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);

  const base = `http://localhost:${process.env.PORT ?? 3000}`;

  // (M1) A content-scoped PAT — every content power, but no "tokens:mint" —
  // must NOT be able to revoke invite links.
  const mint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli", scopes: ["docs:read", "docs:write", "comments:read", "comments:write"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token: pat } = (await mint.json()) as { token: string };
  const patApi: APIRequestContext = await playwright.request.newContext();
  const forbidden = await patApi.delete(`${base}/api/d/${doc.slug}/share`, {
    headers: { authorization: `Bearer ${pat}` },
  });
  expect(forbidden.status()).toBe(403);
  await patApi.dispose();

  // Owner mints a second invite link, so two live invites now exist.
  const share = await page.request.post(`/api/d/${doc.slug}/share`);
  expect(share.status(), await share.text()).toBe(201);
  const { shareUrl: mintedUrl } = (await share.json()) as { shareUrl: string };
  const mintedToken = mintedUrl.slice(mintedUrl.indexOf("#t=") + 3);

  // The reusable invite redeems fine before revocation.
  const anon: APIRequestContext = await playwright.request.newContext();
  const before = await anon.post(`${base}/api/d/${doc.slug}/redeem`, {
    data: { token: doc.inviteToken, name: "Rita Reviewer" },
  });
  expect(before.status(), await before.text()).toBe(200);

  // (M2) Owner revocation kills EXACTLY the two live invites. The owner
  // capability token row (kind = 'owner', consumed by redeemOwner but never
  // revoked) also matches `revoked_at IS NULL`, so if the load-bearing
  // `.eq("kind", "invite")` predicate in the route regressed, this count
  // would read 3 — the anti-lockout carve-out guard.
  const revoke = await page.request.delete(`/api/d/${doc.slug}/share`);
  expect(revoke.status(), await revoke.text()).toBe(200);
  const { revoked } = (await revoke.json()) as { revoked: number };
  expect(revoked).toBe(2);

  // Both previously-minted invite tokens are dead immediately (the revoked_at
  // path through evaluateAccessToken).
  for (const token of [doc.inviteToken, mintedToken]) {
    const after = await anon.post(`${base}/api/d/${doc.slug}/redeem`, {
      data: { token, name: "Rita Reviewer" },
    });
    expect(after.status()).toBe(401);
  }

  // Anti-lockout in practice: the owner session survives revocation and can
  // re-share — a freshly minted invite redeems.
  const reshare = await page.request.post(`/api/d/${doc.slug}/share`);
  expect(reshare.status(), await reshare.text()).toBe(201);
  const { shareUrl: freshUrl } = (await reshare.json()) as { shareUrl: string };
  const freshToken = freshUrl.slice(freshUrl.indexOf("#t=") + 3);
  const redeemFresh = await anon.post(`${base}/api/d/${doc.slug}/redeem`, {
    data: { token: freshToken, name: "Rita Reviewer" },
  });
  expect(redeemFresh.status(), await redeemFresh.text()).toBe(200);
  await anon.dispose();
});
