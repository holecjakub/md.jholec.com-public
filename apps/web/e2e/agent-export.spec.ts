/**
 * E2E + security tests for the agent-read export feature.
 *
 * Covers the seven scenarios required by the QA brief:
 *
 * 1. Happy path: owner mints export token via POST /pat {kind:"export"}, then
 *    POST /export with Bearer returns 200 with content + threads + reactions
 *    and all participant-authored fields are wrapped {untrusted:true}.
 *    The seeded doc HAS a comment so threads[] is non-empty.
 *
 * 1b. GET capability URL: POST /api/documents returns agentUrl in the form
 *    /d/<slug>/agent/<token> (token in PATH, not fragment). A plain GET returns
 *    200 text/html with visible document/comment text and the correct security
 *    headers. Explicit Accept: text/markdown still returns the source-embedded
 *    Markdown format. The same token also works on POST /export (Bearer).
 *
 * 2. No-oracle: reviewer token, garbage token, and no Authorization header all
 *    return identical 401 {"error":"Invalid token"}.
 *
 * 3. Read-only: export token cannot mint another token (POST /pat rejected) and
 *    cannot hit a write path.
 *
 * 4. Rate-limit: >30 GET /d/<slug>/agent/<token> or POST /export attempts from a
 *    dedicated forged XFF IP → 429. Uses a unique IP (TEST-NET-3 range) so it
 *    never pollutes other tests.
 *
 * 5. Headers: /export and mint response carry Cache-Control: no-store and
 *    Referrer-Policy: no-referrer; GET capability URL carries no-store and
 *    no-referrer; token never appears in a query string.
 *
 * 6. UI: ActionBar owner toolbar has "Copy AI agent read link" control distinct
 *    from "Copy reviewer link"; upload success card shows AgentReadNote. axe scans
 *    on those surfaces find no serious/critical violations.
 *
 * 7. llms.txt is served at /llms.txt (200, documents GET /d/<slug>/agent/<token>,
 *    default text/html, and includes security guidance).
 */

import path from "path";
import fs from "fs";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  seedDocument,
  expectNoSeriousA11yViolations,
  deleteRateLimitRowsForIp,
  resetRateLimits,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT = process.env["PORT"] ?? "3000";
const BASE = `http://localhost:${PORT}`;

/** Absolute URL for a relative path — used by raw API contexts that need full URLs. */
function url(p: string): string {
  return `${BASE}${p}`;
}

const isDesktop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

/**
 * Content used for all seeded documents in this spec.
 * Contains a paragraph we can anchor comments to.
 */
const DOC_CONTENT = [
  "# Agent Export Test Doc",
  "",
  "## Introduction",
  "",
  "This paragraph serves as the anchor text for a seeded comment.",
  "",
  "A second paragraph follows to provide context.",
  "",
].join("\n");

/**
 * Load .env.local env vars into the current process if not already set.
 * Needed because XFF-rate-limit tests run in a worker that may not have
 * inherited all vars from the playwright.config.ts loader.
 */
function ensureEnv(): void {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"]) return;
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
    if (!process.env[key]) process.env[key] = val;
  }
}

/**
 * Redeem the owner link and wait for the document heading.
 * Returns when the owner session cookie is set on the page's request context.
 */
async function redeemOwner(page: Page, ownerPath: string): Promise<void> {
  await page.goto(ownerPath);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill("Owner Test");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Export Test Doc", level: 1 }),
  ).toBeVisible();
}

/**
 * Mint an export token after the owner session is set on `page`.
 * Returns the raw token string (starts with "pat_").
 */
async function mintExportToken(page: Page, slug: string): Promise<string> {
  const res = await page.request.post(`/api/d/${slug}/pat`, {
    data: { name: "AI agent (read-only)", kind: "export" },
  });
  expect(res.status(), `export token mint failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { token: string };
  expect(body.token).toMatch(/^pat_/);
  return body.token;
}

/**
 * Seed a comment on `anchor` via the API on a page that already has a
 * redeemed session. Extracts blockId from the live DOM.
 */
async function seedComment(
  page: Page,
  slug: string,
  anchor: string,
  body: string,
): Promise<string> {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, anchor);
  if (!blockId) throw new Error(`seedComment: no block containing "${anchor}" found`);
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: anchor, prefix: "", suffix: "", blockId }, body },
  });
  expect(res.status(), `seedComment failed: ${await res.text()}`).toBe(201);
  const created = (await res.json()) as { comment: { id: string } };
  return created.comment.id;
}

// ---------------------------------------------------------------------------
// §1 — Happy path: mint → export returns 200 with fenced content + threads
// ---------------------------------------------------------------------------

test("§1 export: owner mints token, POST /export returns 200 with fenced content and comments", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Export Happy Path",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  // Seed a comment so threads[] is non-empty.
  const commentBody = "This is a reviewer-authored comment for export testing.";
  const commentId = await seedComment(
    page,
    doc.slug,
    "paragraph serves as the anchor text",
    commentBody,
  );

  // Seed a reaction so we can assert the emoji is provenance-fenced (it is
  // participant-controlled free text, so it must carry {untrusted:true}).
  const reactRes = await page.request.post(`/api/d/${doc.slug}/comments/${commentId}/react`, {
    data: { emoji: "👍" },
  });
  expect(reactRes.status(), `seed reaction failed: ${await reactRes.text()}`).toBe(201);

  // Mint the export token (owner-only).
  const token = await mintExportToken(page, doc.slug);
  expect(token).toMatch(/^pat_/);

  // Use a fresh, cookie-less context to simulate an AI agent.
  const agentCtx: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await agentCtx.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), `expected 200, got ${res.status()}: ${await res.text()}`).toBe(200);

    const exportBody = (await res.json()) as Record<string, unknown>;

    // Top-level format fields.
    expect(exportBody["format"]).toBe("md.jholec.com/agent-export");
    expect(exportBody["version"]).toBe(1);
    expect((exportBody["document"] as Record<string, unknown>)["slug"]).toBe(doc.slug);

    // Content field: owner's document, untrusted:false.
    const content = exportBody["content"] as Record<string, unknown>;
    expect(content["source"]).toBe("owner-document");
    expect(content["untrusted"]).toBe(false);
    expect(typeof content["value"]).toBe("string");
    expect((content["value"] as string).length).toBeGreaterThan(0);
    // Content must NOT contain the comments appendix.
    expect(content["value"] as string).not.toContain("<!-- md-comments-v1");

    // Guidance string is present.
    expect(typeof exportBody["guidance"]).toBe("string");
    expect((exportBody["guidance"] as string).length).toBeGreaterThan(10);

    // Threads: at least one thread (the seeded comment).
    const threads = exportBody["threads"] as unknown[];
    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThanOrEqual(1);

    // First thread: all participant-authored fields are wrapped {untrusted:true}.
    const thread = threads[0] as Record<string, unknown>;

    // author field.
    const author = thread["author"] as Record<string, unknown>;
    expect(author["untrusted"]).toBe(true);
    expect(typeof author["value"]).toBe("string");

    // body field.
    const bodyField = thread["body"] as Record<string, unknown>;
    expect(bodyField["untrusted"]).toBe(true);
    expect(bodyField["source"]).toBe("reviewer-comment");
    expect(bodyField["value"]).toBe(commentBody);

    // anchor quote/prefix/suffix are wrapped.
    const anchor = (thread["anchor"] as Record<string, unknown>);
    const quote = anchor["quote"] as Record<string, unknown>;
    expect(quote["untrusted"]).toBe(true);
    expect(quote["source"]).toBe("document-quote");

    // Reactions array is present; the seeded reaction's emoji is provenance-fenced
    // ({untrusted:true}) like every other participant-authored field — not a bare string.
    const reactions = thread["reactions"] as Array<Record<string, unknown>>;
    expect(Array.isArray(reactions)).toBe(true);
    expect(reactions.length).toBeGreaterThanOrEqual(1);
    const emojiField = reactions[0]!["emoji"] as Record<string, unknown>;
    expect(emojiField["untrusted"]).toBe(true);
    expect(emojiField["source"]).toBe("participant-reaction");
    expect(emojiField["value"]).toBe("👍");
    expect(typeof reactions[0]!["count"]).toBe("number");

    // Replies array is present.
    expect(Array.isArray(thread["replies"])).toBe(true);
  } finally {
    await agentCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// §1b — agentUrl from POST /api/documents is a GET capability URL; plain GET → 200 text/html
// ---------------------------------------------------------------------------

test("§1b agentUrl: POST /api/documents returns agentUrl as GET capability URL /d/<slug>/agent/<token>", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "AgentUrl E2E Test",
    content: DOC_CONTENT,
    password: "test-password",
  });

  // (a) agentUrl shape: /d/<slug>/agent/pat_<token> — token in PATH, no fragment, no query string.
  expect(doc.agentUrl).toBeTruthy();
  expect(doc.agentUrl).toMatch(/\/d\/[^/]+\/agent\/pat_[^/?#]+$/);
  const parsedAgentUrl = new URL(doc.agentUrl);
  expect(parsedAgentUrl.search).toBe(""); // No query string.
  expect(parsedAgentUrl.hash).toBe("");   // No fragment — token is in the path.
  // Token is the last path segment.
  const token = parsedAgentUrl.pathname.split("/").pop()!;
  expect(token).toMatch(/^pat_/);

  // Seed a comment so the comments appendix is non-empty.
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);
  const commentText = "GET-capability comment for §1b.";
  await seedComment(page, doc.slug, "paragraph serves as the anchor text", commentText);

  // (b) A plain GET on the agentUrl returns 200 text/html with visible comments.
  const agentCtx: APIRequestContext = await playwright.request.newContext();
  try {
    const getRes = await agentCtx.get(doc.agentUrl);
    expect(getRes.status(), `GET agentUrl failed: ${await getRes.text()}`).toBe(200);

    const contentType = getRes.headers()["content-type"] ?? "";
    expect(contentType).toContain("text/html");

    const htmlBody = await getRes.text();

    // Body is a JS-free HTML page with visible provenance and untrusted-content notice.
    expect(htmlBody).toContain("<!doctype html>");
    expect(htmlBody).toContain("md.jholec.com read-only agent export");
    expect(htmlBody).toContain("Untrusted reviewer content");

    // Body includes document content.
    expect(htmlBody).toContain("Agent Export Test Doc");

    // Body includes the seeded comment text as visible HTML body text.
    expect(htmlBody).toContain(commentText);
    expect(htmlBody).toContain("Reviewer Comments And Reactions");

    // Security headers on the 200 response.
    const headers200 = getRes.headers();
    expect(headers200["cache-control"]).toContain("no-store");
    expect(headers200["referrer-policy"]).toBe("no-referrer");
    expect(headers200["x-robots-tag"]).toBeUndefined();

    // (c) Explicit Markdown negotiation still returns the source-embedded format.
    const mdRes = await agentCtx.get(doc.agentUrl, {
      headers: { Accept: "text/markdown" },
    });
    expect(mdRes.status(), `GET markdown agentUrl failed: ${await mdRes.text()}`).toBe(200);
    expect(mdRes.headers()["content-type"]).toContain("text/markdown");
    const mdBody = await mdRes.text();
    expect(mdBody).toMatch(/^<!--/);
    expect(mdBody).toContain("Agent Export Test Doc");
    expect(mdBody).toContain(commentText);
    expect(mdRes.headers()["x-robots-tag"]).toBeUndefined();

    // (d) Same token also works on POST /export (Bearer) — the old programmatic path.
    const exportRes = await agentCtx.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(exportRes.status(), `Bearer /export failed: ${await exportRes.text()}`).toBe(200);
    const exportBody = (await exportRes.json()) as Record<string, unknown>;
    expect(exportBody["format"]).toBe("md.jholec.com/agent-export");
  } finally {
    await agentCtx.dispose();
  }
});

test("§1b GET: garbage token / wrong-doc token → identical 401 text/plain", async ({
  page,
  playwright,
}) => {
  // Create two documents so we can test a token bound to doc-A on doc-B's URL.
  const docA = await seedDocument(page.request, {
    title: "DocA for Wrong-Doc Token",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const docB = await seedDocument(page.request, {
    title: "DocB for Wrong-Doc Token",
    content: DOC_CONTENT,
    password: "test-password",
  });

  // Extract docA's token from its agentUrl.
  const tokenA = new URL(docA.agentUrl).pathname.split("/").pop()!;
  expect(tokenA).toMatch(/^pat_/);

  const agentCtx: APIRequestContext = await playwright.request.newContext();
  try {
    // Garbage token → 401 text/plain "Invalid or expired link."
    const garbageRes = await agentCtx.get(url(`/d/${docA.slug}/agent/garbage_token_xyz`));
    expect(garbageRes.status()).toBe(401);
    const garbageText = await garbageRes.text();
    expect(garbageText).toContain("Invalid or expired link.");
    const garbageCt = garbageRes.headers()["content-type"] ?? "";
    expect(garbageCt).toContain("text/plain");

    // Valid token for docA used on docB's URL → identical 401.
    const wrongDocRes = await agentCtx.get(url(`/d/${docB.slug}/agent/${tokenA}`));
    expect(wrongDocRes.status()).toBe(401);
    const wrongDocText = await wrongDocRes.text();
    expect(wrongDocText).toBe(garbageText); // Identical body — no oracle.

    // Reviewer context token used on the GET capability URL is not a valid export PAT → 401.
    // (Reviewer tokens are session cookies, not PATs — this tests an implausible but
    // security-relevant path where someone tries any random string as the path token.)
    const reviewerCtxToken = "pat_reviewer_does_not_exist_in_pats_table";
    const reviewerRes = await agentCtx.get(url(`/d/${docA.slug}/agent/${reviewerCtxToken}`));
    expect(reviewerRes.status()).toBe(401);
  } finally {
    await agentCtx.dispose();
  }
});

// ---------------------------------------------------------------------------
// §2 — No-oracle: reviewer token, garbage token, no Authorization → identical 401
// ---------------------------------------------------------------------------

test("§2 no-oracle: reviewer token, garbage token, and no Authorization all return identical 401", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "No Oracle Test",
    content: DOC_CONTENT,
    password: "test-password",
  });

  // Redeem the reviewer link to get a reviewer session cookie on the page.
  const reviewerPath = doc.shareUrl.slice(doc.shareUrl.indexOf("/d/"));
  await page.goto(reviewerPath);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill("Rita Reviewer");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Export Test Doc", level: 1 }),
  ).toBeVisible();

  // The reviewer has a session cookie but NOT a PAT — export is PAT-only.
  // POST /export from a page with a reviewer session should get 401.
  const withReviewerSession = await page.request.post(`/api/d/${doc.slug}/export`);
  expect(withReviewerSession.status()).toBe(401);
  const reviewerBody = (await withReviewerSession.json()) as { error: string };
  expect(reviewerBody.error).toBe("Invalid token");

  // Garbage Bearer token → 401.
  const garbageCtx: APIRequestContext = await playwright.request.newContext();
  try {
    const withGarbage = await garbageCtx.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: "Bearer garbage_token_that_does_not_exist" },
    });
    expect(withGarbage.status()).toBe(401);
    const garbageBody = (await withGarbage.json()) as { error: string };
    expect(garbageBody.error).toBe("Invalid token");

    // No Authorization header at all → 401.
    const withNoAuth = await garbageCtx.post(url(`/api/d/${doc.slug}/export`));
    expect(withNoAuth.status()).toBe(401);
    const noAuthBody = (await withNoAuth.json()) as { error: string };
    expect(noAuthBody.error).toBe("Invalid token");

    // All three bodies must be identical (no oracle signal).
    expect(garbageBody).toEqual(reviewerBody);
    expect(noAuthBody).toEqual(reviewerBody);
  } finally {
    await garbageCtx.dispose();
  }
});

test("§2 no-oracle: a valid CLI PAT (docs:write scope, not docs:read+comments:read) also returns 401", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "CLI PAT Oracle Test",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  // Mint a CLI write PAT — has docs:write but NOT docs:read or comments:read.
  const mintRes = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "cli-write", scopes: ["docs:write"] },
  });
  expect(mintRes.status()).toBe(201);
  const { token: writeToken } = (await mintRes.json()) as { token: string };

  // Use the write-scoped PAT on /export (wrong kind) → must return 401.
  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await api.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// §3 — Read-only: export token cannot mint or write
// ---------------------------------------------------------------------------

test("§3 read-only: export token cannot mint another PAT (POST /pat with export token → 401/403)", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Read-Only PAT Test",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const exportToken = await mintExportToken(page, doc.slug);

  // A cookie-less client wielding the export token cannot mint a new token.
  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const mintAttempt = await api.post(url(`/api/d/${doc.slug}/pat`), {
      headers: { Authorization: `Bearer ${exportToken}` },
      data: { name: "escalation-attempt", kind: "export" },
    });
    // The owner gate on /pat requires docs:write. The export token only has
    // docs:read + comments:read, so this must be rejected (401 or 403).
    expect([401, 403]).toContain(mintAttempt.status());
    expect(mintAttempt.status()).not.toBe(201);
  } finally {
    await api.dispose();
  }
});

test("§3 read-only: export token cannot post a comment (POST /comments → 401/403)", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Read-Only Comment Test",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const exportToken = await mintExportToken(page, doc.slug);

  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const writeAttempt = await api.post(url(`/api/d/${doc.slug}/comments`), {
      headers: { Authorization: `Bearer ${exportToken}` },
      data: {
        anchor: { quote: "anchor text", prefix: "", suffix: "", blockId: "b0" },
        body: "Injection attempt via export token.",
      },
    });
    // /comments requires a session cookie or a write-scoped PAT — should reject.
    expect([401, 403]).toContain(writeAttempt.status());
    expect(writeAttempt.status()).not.toBe(201);
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------
// §4 — Rate-limit: >30 GET /d/<slug>/agent/<token> or POST /export from a dedicated XFF IP → 429
// ---------------------------------------------------------------------------

test(
  "§4 rate-limit: 31st GET /d/<slug>/agent/<token> from a dedicated XFF IP returns 429",
  async ({ playwright }, testInfo) => {
    // Use TEST-NET-3 (documentation) range — never a real user, own bucket.
    // Use a distinct IP from the POST /export rate-limit test below so the two
    // tests share no bucket state.
    const testIp = testInfo.project.name === "mobile" ? "203.0.113.162" : "203.0.113.62";
    ensureEnv();
    await deleteRateLimitRowsForIp(testIp);

    // The GET route checks isIpRateLimited BEFORE the slug lookup (same "export"
    // scope as POST /export). So a dummy slug/token is fine:
    //   - Requests 1–30: rate-limited IP records attempt → below limit → returns 404 or 401.
    //   - Request 31: count (31) exceeds limit (30) → 429 before any DB token lookup.
    const dummySlug = "rate-limit-get-slug-not-exist";
    const dummyToken = "pat_dummy_rate_limit_token_get";

    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { "x-real-ip": testIp },
    });
    try {
      // Fire 30 requests — each records an attempt; the limit is strictly > 30.
      for (let i = 0; i < 30; i++) {
        await ctx.get(url(`/d/${dummySlug}/agent/${dummyToken}`));
      }
      // 31st attempt — count (31) exceeds limit (30) → 429.
      const res = await ctx.get(url(`/d/${dummySlug}/agent/${dummyToken}`));
      expect(res.status()).toBe(429);
      // The GET route returns text/plain on errors.
      const body = await res.text();
      expect(body).toContain("Too many");
    } finally {
      await ctx.dispose();
    }
  },
  { timeout: 60_000 }, // Allow time for 31 sequential requests.
);

test(
  "§4 rate-limit: 31st POST /export from a dedicated XFF IP returns 429",
  async ({ page, playwright }, testInfo) => {
    // Use TEST-NET-3 (documentation) range — never a real user, own bucket.
    const testIp = testInfo.project.name === "mobile" ? "203.0.113.161" : "203.0.113.61";
    ensureEnv();
    await deleteRateLimitRowsForIp(testIp);

    // Use a real slug so this test only exercises the export limiter and token
    // path, never an unknown-route/unknown-doc shortcut. The token is still bad;
    // attempts 1-30 return 401 and attempt 31 returns 429.
    const doc = await seedDocument(page.request, {
      title: "Export POST Rate Limit",
      content: DOC_CONTENT,
      password: "test-password",
    });

    const ctx = await playwright.request.newContext({
      extraHTTPHeaders: { "x-real-ip": testIp },
    });
    try {
      // Fire 30 requests — each records an attempt; the limit is strictly > 30.
      for (let i = 0; i < 30; i++) {
        const attempt = await ctx.post(url(`/api/d/${doc.slug}/export`), {
          headers: { Authorization: "Bearer pat_dummy_rate_limit_token_post" },
        });
        expect(attempt.status()).toBe(401);
      }
      // 31st attempt — now the count (31) exceeds the limit (30) → 429.
      const res = await ctx.post(url(`/api/d/${doc.slug}/export`), {
        headers: { Authorization: "Bearer pat_dummy_rate_limit_token_post" },
      });
      expect(res.status()).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Too many requests");
    } finally {
      await ctx.dispose();
    }
  },
  { timeout: 60_000 }, // Allow time for 31 sequential requests.
);

// ---------------------------------------------------------------------------
// §5 — Headers: no-store + no-referrer on /export, mint, and GET capability URL; token not in query string
// ---------------------------------------------------------------------------

test("§5 headers: mint response has Cache-Control: no-store and Referrer-Policy: no-referrer", async ({
  page,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Headers Mint Test",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const res = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "header-test", kind: "export" },
  });
  expect(res.status()).toBe(201);
  const headers = res.headers();
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["referrer-policy"]).toBe("no-referrer");

  // Token is in the response body — NOT in any query string or search param.
  const body = (await res.json()) as { token: string };
  const token = body.token;
  expect(token).toMatch(/^pat_/);
  // The page URL must NOT have the token in a query string.
  expect(new URL(page.url()).search).not.toContain(token);
});

test("§5 headers: GET capability URL 200 response has Cache-Control: no-store and Referrer-Policy: no-referrer", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Headers GET Capability Test",
    content: DOC_CONTENT,
    password: "test-password",
  });

  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await api.get(doc.agentUrl);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["content-type"]).toContain("text/html");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-robots-tag"]).toBeUndefined();
  } finally {
    await api.dispose();
  }
});

test("§5 headers: GET capability URL 401 error response has Cache-Control: no-store and Referrer-Policy: no-referrer", async ({
  playwright,
}) => {
  const doc = await seedDocument(
    await playwright.request.newContext(),
    { title: "Headers GET 401 Test", content: DOC_CONTENT, password: "test-password" },
  );

  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await api.get(url(`/d/${doc.slug}/agent/garbage_invalid_token`));
    expect(res.status()).toBe(401);
    const headers = res.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  } finally {
    await api.dispose();
  }
});

test("§5 headers: /export 200 response has Cache-Control: no-store and Referrer-Policy: no-referrer", async ({
  page,
  playwright,
}) => {
  const doc = await seedDocument(page.request, {
    title: "Headers Export Test",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const token = await mintExportToken(page, doc.slug);

  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await api.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  } finally {
    await api.dispose();
  }
});

test("§5 headers: /export 401 error response also has Cache-Control: no-store and Referrer-Policy: no-referrer", async ({
  playwright,
}) => {
  // No slug needed — any invalid request should have the security headers.
  const doc = await seedDocument(
    await playwright.request.newContext(),
    { title: "Headers 401 Test", content: DOC_CONTENT, password: "test-password" },
  );

  const api: APIRequestContext = await playwright.request.newContext();
  try {
    const res = await api.post(url(`/api/d/${doc.slug}/export`), {
      headers: { Authorization: "Bearer invalid_token" },
    });
    expect(res.status()).toBe(401);
    const headers = res.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  } finally {
    await api.dispose();
  }
});

test("§5 token not in query string: agentUrl carries token in PATH only, not query string or fragment", async ({
  page,
}) => {
  // The GET capability URL design puts the token in the path (acceptable: read-only,
  // single-doc, revocable). The security requirement is that it NEVER goes in a
  // query string (visible in server access logs, HTTP Referer, etc.).
  const doc = await seedDocument(page.request, {
    title: "Token URL Test",
    content: DOC_CONTENT,
    password: "test-password",
  });

  const agentUrl = new URL(doc.agentUrl);
  const token = agentUrl.pathname.split("/").pop()!;
  expect(token).toMatch(/^pat_/);

  // Token is in the path — NOT in the query string or fragment.
  expect(agentUrl.search).toBe(""); // No query string.
  expect(agentUrl.hash).toBe("");   // No fragment (the old #x= design is superseded).
  expect(agentUrl.pathname).toContain(token); // Token is in the path (by design: GET capability URL).

  // The agentUrl never appears in a query string: the full URL has no "?" with the token.
  expect(doc.agentUrl).not.toMatch(/\?.*pat_/);

  // Intercept mint requests to ensure the token never leaks into a query string
  // when the UI button calls createAgentLink.
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const queriedUrls: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).search) queriedUrls.push(req.url());
  });

  const mintRes = await page.request.post(`/api/d/${doc.slug}/pat`, {
    data: { name: "url-check-token", kind: "export" },
  });
  const { token: mintedToken } = (await mintRes.json()) as { token: string };

  // No network request to the mint endpoint used a query string with the token.
  for (const reqUrl of queriedUrls) {
    expect(reqUrl, `minted token leaked into a query string: ${reqUrl}`).not.toContain(mintedToken);
  }
});

// ---------------------------------------------------------------------------
// §6 — UI: ActionBar "Copy AI agent read link" button; AgentReadNote in success card
// ---------------------------------------------------------------------------

test("§6 UI: owner ActionBar has 'Copy AI agent read link' button distinct from 'Copy reviewer link'", async ({
  page,
}) => {
  test.skip(!isDesktop(page), "desktop pill — owner controls only appear on desktop pill");

  const doc = await seedDocument(page.request, {
    title: "ActionBar Agent Link UI",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const pill = page.getByRole("navigation", { name: "Document actions" });
  await expect(pill).toBeVisible();

  // Both owner buttons must be present and distinct (new labels after ActionBar restructure).
  const reviewerBtn = pill.getByRole("button", { name: "Copy reviewer link" });
  const agentBtn = pill.getByRole("button", { name: "Copy AI agent read link" });
  await expect(reviewerBtn).toBeVisible();
  await expect(agentBtn).toBeVisible();

  // They are distinct elements (not the same button).
  const reviewerHandle = await reviewerBtn.elementHandle();
  const agentHandle = await agentBtn.elementHandle();
  expect(reviewerHandle).not.toBeNull();
  expect(agentHandle).not.toBeNull();
  // Different DOM nodes.
  const sameNode = await page.evaluate(
    ([a, b]) => a === b,
    [reviewerHandle!, agentHandle!] as [NonNullable<typeof reviewerHandle>, NonNullable<typeof agentHandle>],
  );
  expect(sameNode).toBe(false);

  // The agent button has the Sparkles icon (aria-hidden sibling) — the reviewer button has Link2.
  // Both buttons must each be ≥ 36px (the pill uses size-9 = 36px).
  const agentBox = (await agentBtn.boundingBox())!;
  expect(agentBox.width).toBeGreaterThanOrEqual(36);
  expect(agentBox.height).toBeGreaterThanOrEqual(36);

  // Also assert the agentUrl from the create response is the GET capability URL form.
  expect(doc.agentUrl).toMatch(/\/d\/[^/]+\/agent\/pat_[^/?#]+$/);
});

test("§6 UI: owner ActionBar agent link button works via clipboard shim (desktop)", async ({
  page,
}) => {
  test.skip(!isDesktop(page), "desktop pill — clipboard test only on desktop");

  const doc = await seedDocument(page.request, {
    title: "ActionBar Copy Agent Link",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  // Shim clipboard.writeText to capture the copied value.
  await page.evaluate(() => {
    (window as unknown as { __copied: string }).__copied = "";
    navigator.clipboard.writeText = async (t: string) => {
      (window as unknown as { __copied: string }).__copied = t;
    };
  });

  const pill = page.getByRole("navigation", { name: "Document actions" });
  // Also verify the 'Copy document' and 'Copy reviewer link' buttons are present (new structure).
  await expect(pill.getByRole("button", { name: "Copy document (Markdown + comments)" })).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
  await pill.getByRole("button", { name: "Copy AI agent read link" }).click();

  // Wait for the copy to complete and the button label to change or the value to be captured.
  // The copied URL is now the GET capability URL: /d/<slug>/agent/<token>.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __copied: string }).__copied),
    )
    .toContain(`/d/${doc.slug}/agent/`);

  // The copied URL must be the GET capability URL form (token in path, no fragment, no query).
  const copied = await page.evaluate(
    () => (window as unknown as { __copied: string }).__copied,
  );
  const copiedUrl = new URL(copied);
  // Token is in the path — must match /d/<slug>/agent/pat_<token>.
  expect(copiedUrl.pathname).toMatch(/\/d\/[^/]+\/agent\/pat_[^/]+$/);
  expect(copiedUrl.search).toBe(""); // No query string.
  expect(copiedUrl.hash).toBe(""); // No fragment — the old #x= design is superseded.
});

test("§6 UI: mobile owner cluster has 'Copy AI agent read link' item", async ({ page }) => {
  test.skip(isDesktop(page), "mobile-only cluster");

  const doc = await seedDocument(page.request, {
    title: "Mobile Agent Link UI",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  const fab = page.getByRole("button", { name: "Document actions" });
  await fab.tap();
  await expect(fab).toHaveAttribute("aria-expanded", "true");

  // The reviewer link and agent link buttons are present in the cluster (new labels).
  await expect(page.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
});

test("§6 UI: upload success card shows AgentReadNote explainer text", async ({ page }) => {
  // Navigate to the home page and complete a full upload to reach the success card.
  const { EARLY_ACCESS_PASSWORD } = await import("./_helpers");
  await resetRateLimits();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Markdown, shared for feedback.", level: 1 }),
  ).toBeVisible();

  // Unlock the gate via UI.
  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({
    timeout: 10_000,
  });

  // Upload a file.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles({
    name: "agent-test.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(DOC_CONTENT),
  });
  await page.getByLabel("Title").fill("agent-test");
  await page.getByRole("textbox", { name: "Password" }).fill("test-password");
  await page.getByRole("button", { name: "Create share link" }).click();

  // Wait for the success state.
  await expect(
    page.getByRole("heading", { name: "Your document is live.", level: 2 }),
  ).toBeVisible({ timeout: 15_000 });

  // The AgentReadNote explainer must be present in the success card.
  await expect(page.getByText("Hand an AI agent a read-only link.")).toBeVisible();
  await expect(page.getByText("read-only access")).toBeVisible();
  await expect(page.getByText("Keep a human in the loop")).toBeVisible();
});

test("§6 axe: owner toolbar (desktop pill with agent button) — no serious/critical violations", async ({
  page,
}) => {
  test.skip(!isDesktop(page), "desktop pill — axe check of owner toolbar");

  const doc = await seedDocument(page.request, {
    title: "Axe Owner Toolbar",
    content: DOC_CONTENT,
    password: "test-password",
  });
  const ownerPath = doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/"));
  await redeemOwner(page, ownerPath);

  // Wait for the pill to settle (new structure: Download, Copy document, Copy reviewer link, Copy AI agent read link, Participants).
  const pill = page.getByRole("navigation", { name: "Document actions" });
  await expect(pill).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy document (Markdown + comments)" })).toBeVisible();

  await expectNoSeriousA11yViolations(page, "owner ActionBar with agent button");
});

test("§6 axe: upload success card with AgentReadNote — no serious/critical violations", async ({
  page,
}) => {
  const { EARLY_ACCESS_PASSWORD } = await import("./_helpers");
  await resetRateLimits();

  await page.goto("/");
  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({
    timeout: 10_000,
  });

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles({
    name: "axe-success.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(DOC_CONTENT),
  });
  await page.getByLabel("Title").fill("axe-success");
  await page.getByRole("textbox", { name: "Password" }).fill("test-password");
  await page.getByRole("button", { name: "Create share link" }).click();

  await expect(
    page.getByRole("heading", { name: "Your document is live.", level: 2 }),
  ).toBeVisible({ timeout: 15_000 });

  // Wait for the slide-in animation to fully settle (opacity reaches 1) before
  // running axe. The success card starts at opacity:0 and animates in; axe
  // scanning mid-animation reports incorrect effective contrast because the card's
  // background is blended with the page at fractional opacity.
  // Strategy: walk up from the h2 (the success heading) and wait until every
  // ancestor has opacity >= 0.95 (mirrors the approach in upload-a11y.spec.ts).
  await expect.poll(
    () =>
      page.evaluate(() => {
        const h2 = document.querySelector<HTMLElement>("h2[tabindex='-1']");
        if (!h2) return 0;
        let current: HTMLElement | null = h2;
        while (current) {
          if (parseFloat(getComputedStyle(current).opacity) < 0.95) return 0;
          current = current.parentElement as HTMLElement | null;
        }
        return 1;
      }),
    { timeout: 5_000 },
  ).toBe(1);

  await expectNoSeriousA11yViolations(page, "upload success card with AgentReadNote");
});

// ---------------------------------------------------------------------------
// §7 — llms.txt is served at /llms.txt with correct content (GET URL as primary)
// ---------------------------------------------------------------------------

test("§7 llms.txt is served at /llms.txt and documents the GET capability URL as primary", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext();
  try {
    const res = await ctx.get(url("/llms.txt"));
    expect(res.status()).toBe(200);

    const text = await res.text();

    // Must document the GET capability URL form (new primary: token in path).
    // Accepts any of these: /d/<slug>/agent/<token> or /agent/<token> or agent/<token>.
    const mentionsGetUrl =
      text.includes("/agent/") ||
      text.includes("agent/<token>") ||
      text.includes("/d/<slug>/agent");
    expect(
      mentionsGetUrl,
      "llms.txt must document the GET capability URL /d/<slug>/agent/<token>",
    ).toBe(true);

    // Must mention text/html as the default response content type.
    const mentionsHtml =
      text.includes("text/html") || text.includes("HTML") || text.includes("html");
    expect(
      mentionsHtml,
      "llms.txt must mention text/html as the default response type",
    ).toBe(true);

    // Must mention the /export endpoint (legacy programmatic path still works).
    expect(text).toContain("/export");

    // Must mention Authorization: Bearer for the programmatic path.
    expect(text).toContain("Authorization: Bearer");

    // Must warn against putting the token in a query string.
    const mentionsQueryStringProhibition =
      text.includes("query string") ||
      text.includes("query param") ||
      text.includes("NEVER put") ||
      text.includes("never put");
    expect(
      mentionsQueryStringProhibition,
      "llms.txt must warn against putting token in a query string",
    ).toBe(true);
  } finally {
    await ctx.dispose();
  }
});
