import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Focused security-audit regression guards:
 *
 * M1 (least privilege): a reviewer-grade PAT carrying ONLY "comments:write" — the
 *     minimum scope a commenting integration needs — must be rejected (403) by both
 *     credential-minting endpoints, POST /api/d/[slug]/share and POST /api/d/[slug]/pat,
 *     while the owner cookie session succeeds on the very same calls. This pins the
 *     ownerAuthority gate from the PAT side that security-pat.spec.ts covers with
 *     an all-content-scopes token.
 *
 * M3 (redeem race): the single-use owner capability token is consumed atomically
 *     (conditional UPDATE … WHERE consumed_at IS NULL acts as a compare-and-swap)
 *     BEFORE any session is minted, so N concurrent redeems of the same token yield
 *     exactly ONE session — not N.
 */

const CONTENT = "# Least Privilege\n\nA paragraph.\n";

async function createDoc(page: Page) {
  const doc = await seedDocument(page.request, {
    title: "Least-Privilege Doc",
    content: CONTENT,
    password: "test-password",
  });
  return {
    slug: doc.slug,
    ownerPath: doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/")),
    ownerToken: doc.ownerUrl.slice(doc.ownerUrl.indexOf("#o=") + 3),
  };
}

async function redeemOwner(page: Page, ownerPath: string) {
  await page.goto(ownerPath);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill("Olivia Owner");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Least Privilege", level: 1 }),
  ).toBeVisible();
}

test("a comments:write-only PAT gets 403 from /share and /pat while the owner session succeeds (M1)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  await redeemOwner(page, doc.ownerPath);

  // Owner mints the least-privilege reviewer PAT: comments:write ONLY.
  const mint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "commenter", scopes: ["comments:write"] },
  });
  expect(mint.status(), await mint.text()).toBe(201);
  const { token } = (await mint.json()) as { token: string };
  expect(token).toMatch(/^pat_/);

  const api: APIRequestContext = await playwright.request.newContext();
  const base = `http://localhost:${process.env.PORT ?? 3000}`;
  const headers = { authorization: `Bearer ${token}` };

  // The PAT authenticates fine but must NOT clear the ownerAuthority gate on the
  // invite-minting route. /share only demands the "comments:write" scope, which this
  // PAT carries — so a 403 here is specifically the M1 authority check, not a scope
  // or validity failure (those would also be 403/401, but the paired owner-session
  // success below plus the scope match pins the distinction).
  const share = await api.post(`${base}/api/d/${doc.slug}/share`, { headers });
  expect(share.status(), await share.text()).toBe(403);

  // Nor may it mint further tokens — neither an export token nor a CLI PAT.
  const exportMint = await api.post(`${base}/api/d/${doc.slug}/pat`, {
    headers,
    data: { name: "escalated", kind: "export" },
  });
  expect(exportMint.status()).toBe(403);
  const cliMint = await api.post(`${base}/api/d/${doc.slug}/pat`, {
    headers,
    data: { name: "escalated", scopes: ["docs:read", "tokens:mint"] },
  });
  expect(cliMint.status()).toBe(403);
  await api.dispose();

  // The owner cookie session succeeds on the exact same endpoints.
  const ownerShare = await page.request.post(`/api/d/${doc.slug}/share`);
  expect(ownerShare.status(), await ownerShare.text()).toBe(201);
  const { shareUrl } = (await ownerShare.json()) as { shareUrl: string };
  expect(shareUrl).toContain("#t=");

  const ownerMint = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "owner-cli", scopes: ["docs:read"] },
  });
  expect(ownerMint.status(), await ownerMint.text()).toBe(201);
  const minted = (await ownerMint.json()) as { token: string; expiresAt: string };
  expect(minted.token).toMatch(/^pat_/);
});

test("owner capability link supports repeated re-entry (reusable owner token)", async ({
  page,
  playwright,
}) => {
  const doc = await createDoc(page);
  const base = `http://localhost:${process.env.PORT ?? 3000}`;

  // The owner link is now a REUSABLE capability (fix/owner-link-reentry): the
  // owner must be able to re-open their OWN document at any time — a new browser,
  // or after the 1h owner session expires — not only once. So repeated (and even
  // concurrent) redeems of the same owner token each mint a fresh OWNER session,
  // and the owner never gets silently downgraded to a reviewer/password session
  // (which broke Revoke & regenerate and every other owner-only control).
  //
  // This deliberately drops the previous single-use "theft-detection" property:
  // in a no-accounts, link-based product the owner link IS the credential, and a
  // one-shot owner link makes re-entry impossible. The link stays bounded by the
  // 30-day expiry (dies with the document) and is revocable via revoked_at.
  const RACERS = 4;
  const contexts: APIRequestContext[] = await Promise.all(
    Array.from({ length: RACERS }, () => playwright.request.newContext()),
  );
  const results = await Promise.all(
    contexts.map((ctx, i) =>
      ctx.post(`${base}/api/d/${doc.slug}/redeem`, {
        data: { token: doc.ownerToken, name: `Racer ${i}` },
      }),
    ),
  );

  const statuses = results.map((r) => r.status());
  // Every redeem succeeds (the token is not consumed)…
  expect(statuses, `statuses: ${statuses.join(", ")}`).toEqual(Array(RACERS).fill(200));
  // …and every session is an OWNER session.
  const roles = await Promise.all(results.map(async (r) => ((await r.json()) as { role: string }).role));
  expect(roles, `roles: ${roles.join(", ")}`).toEqual(Array(RACERS).fill("owner"));

  // A later, non-racing redeem still works — genuine re-entry after the fact.
  const later = await contexts[0]!.post(`${base}/api/d/${doc.slug}/redeem`, {
    data: { token: doc.ownerToken, name: "Latecomer" },
  });
  expect(later.status(), await later.text()).toBe(200);
  expect(((await later.json()) as { role: string }).role).toBe("owner");

  await Promise.all(contexts.map((ctx) => ctx.dispose()));
});
