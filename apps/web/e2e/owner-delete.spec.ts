import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * End-to-end coverage for OWNER comment moderation (delete).
 *
 * The document owner can delete any comment (their own or a reviewer's) as a
 * moderation tool. The control is an unobtrusive, owner-only trash icon on each
 * comment row that morphs into a lightweight "Delete? / Cancel" confirm so a
 * delete is never a one-tap accident. Deleting a ROOT comment removes the whole
 * thread (its margin badge + inline underline vanish); deleting a reply removes
 * just that reply.
 *
 * Security is enforced SERVER-side: a reviewer never sees the control AND a raw
 * DELETE issued with a reviewer session is rejected with 403. Resolve must keep
 * working alongside the new control.
 *
 * Each test creates a real document via POST /api/documents, redeems through the
 * gate, seeds comment(s) via the API (deterministic — avoids the flaky
 * selection→composer path covered elsewhere), then exercises the popover.
 */

const SENTENCE_A = "Revenue grew twelve percent this period.";
const SENTENCE_B = "Churn fell to a record low of two percent.";

const MARKDOWN_CONTENT = [
  "# Quarterly Report",
  "",
  "## Summary",
  "",
  "Highlights of the quarter are summarized in this opening paragraph for review.",
  "",
  `${SENTENCE_A} ${SENTENCE_B}`,
  "",
  "- First milestone shipped",
  "- Second milestone in progress",
  "",
].join("\n");

interface CreatedDoc {
  slug: string;
  inviteUrl: string; // /d/{slug}#t={token}
  ownerUrl: string; // /d/{slug}#o={token}
}

/** Create a document via the gate-aware seed helper and return its slug + share/owner URLs. */
async function createDocument(page: Page): Promise<CreatedDoc> {
  const doc = await seedDocument(page.request, {
    title: "E2E Owner-Delete Doc",
    content: MARKDOWN_CONTENT,
    password: "test-password",
  });

  const toPath = (url: string) => url.slice(url.indexOf("/d/"));
  return {
    slug: doc.slug,
    inviteUrl: toPath(doc.shareUrl),
    ownerUrl: toPath(doc.ownerUrl),
  };
}

/** Redeem an invite/owner URL through the gate and wait for the rendered doc. */
async function redeemAndOpen(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();
}

/**
 * Seed a comment on `sentence` via the API and return the created comment id.
 * Requires the doc to be open (so [data-block-id] blocks exist) and a redeemed
 * session cookie (page.request shares the context cookies).
 */
async function seedComment(
  page: Page,
  slug: string,
  sentence: string,
  body: string,
): Promise<string> {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, sentence);
  if (!blockId) throw new Error(`seedComment: no block contains "${sentence}"`);
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: sentence, prefix: "", suffix: "", blockId }, body },
  });
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()) as { comment: { id: string } };
  expect(created.comment.id).toBeTruthy();
  return created.comment.id;
}

/** Seed a reply to a parent comment via the API; returns the reply id. */
async function seedReply(
  page: Page,
  slug: string,
  parentId: string,
  body: string,
): Promise<string> {
  const res = await page.request.post(`/api/d/${slug}/comments/${parentId}/reply`, {
    data: { body },
  });
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()) as { comment: { id: string } };
  return created.comment.id;
}

function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

function anyBadge(page: Page) {
  return page.locator('button[aria-label*="comment thread"]');
}

function anyHighlight(page: Page) {
  return page.locator("span.md-comment-highlight");
}

/** Reload + wait for the rendered doc (deterministic render of seeded data). */
async function reloadDoc(page: Page): Promise<void> {
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();
}

test.describe("Owner moderation — delete comments", () => {
  test("owner: trash → confirm → root delete removes the thread (badge + underline)", async ({
    page,
  }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");

    await seedComment(page, doc.slug, SENTENCE_A, "Please cite the revenue figure.");
    await reloadDoc(page);

    await expect(anyHighlight(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(anyBadge(page).first()).toBeVisible();
    await anyBadge(page).first().click();

    const thread = threadPopover(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Please cite the revenue figure.");

    // The owner-only trash control is present (one comment → one delete button).
    const trash = thread.getByRole("button", { name: /Delete comment by/ });
    await expect(trash).toHaveCount(1);

    // First click does NOT delete — it morphs into a confirm. The comment stays.
    await trash.first().click();
    await expect(thread.getByText("Delete?")).toBeVisible();
    await expect(thread).toContainText("Please cite the revenue figure.");

    // Esc cancels the confirm without deleting (still keyboard-operable).
    await page.keyboard.press("Escape");
    await expect(thread.getByText("Delete?")).toBeHidden();
    await expect(thread).toContainText("Please cite the revenue figure.");

    // Re-open the confirm and confirm the delete.
    await thread.getByRole("button", { name: /Delete comment by/ }).first().click();
    await thread.getByRole("button", { name: "Delete", exact: true }).click();

    // Deleting the root removes the whole thread: popover closes, badge +
    // underline disappear.
    await expect(thread).toBeHidden({ timeout: 10_000 });
    await expect(anyBadge(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(anyHighlight(page)).toHaveCount(0, { timeout: 10_000 });

    // And it is gone server-side: a fresh load shows no comments.
    await reloadDoc(page);
    await expect(anyBadge(page)).toHaveCount(0);
  });

  test("owner: deleting a reply removes only the reply; the root thread remains", async ({
    page,
  }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Owen Owner");

    const rootId = await seedComment(page, doc.slug, SENTENCE_A, "Root comment stays.");
    await seedReply(page, doc.slug, rootId, "Reply to be removed.");
    await reloadDoc(page);

    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
    await anyBadge(page).first().click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Root comment stays.");
    await expect(thread).toContainText("Reply to be removed.");

    // Two comments → two trash controls. Delete the SECOND row (the reply).
    const trashes = thread.getByRole("button", { name: /Delete comment by/ });
    await expect(trashes).toHaveCount(2);
    await trashes.nth(1).click();
    await thread.getByRole("button", { name: "Delete", exact: true }).click();

    // The reply vanishes; the root (and the thread/badge) remains.
    await expect(thread).toContainText("Root comment stays.");
    await expect(thread.getByText("Reply to be removed.")).toBeHidden({ timeout: 10_000 });
    await expect(thread).toBeVisible();
    await expect(anyBadge(page).first()).toBeVisible();
  });

  test("reviewer: no trash control AND server-side DELETE is 403", async ({ page }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Rita Reviewer");

    const commentId = await seedComment(page, doc.slug, SENTENCE_A, "Reviewer cannot delete me.");
    await reloadDoc(page);

    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
    await anyBadge(page).first().click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Reviewer cannot delete me.");

    // The reviewer NEVER sees a delete affordance.
    await expect(thread.getByRole("button", { name: /Delete comment by/ })).toHaveCount(0);

    // Security is enforced server-side, not just hidden in the UI: a raw DELETE
    // with the reviewer's session is rejected with 403.
    const res = await page.request.delete(`/api/d/${doc.slug}/comments/${commentId}`);
    expect(res.status()).toBe(403);

    // And the comment is still there after the rejected attempt.
    await reloadDoc(page);
    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
    await anyBadge(page).first().click();
    await expect(threadPopover(page)).toContainText("Reviewer cannot delete me.");
  });

  test("mobile: owner trash is discoverable at rest and the confirm row fits", async ({
    page,
  }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) >= 640,
      "this asserts the coarse-pointer (mobile) resting-visibility + fit nits",
    );

    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Mona Mobile");

    await seedComment(page, doc.slug, SENTENCE_A, "Discover me on mobile.");
    await reloadDoc(page);

    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
    await anyBadge(page).first().tap();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();

    // (1) On a coarse/touch pointer there is no hover to reveal the trash, so it
    // must rest at a low-but-visible opacity (not 0) — discoverable by a mobile
    // owner without any hover.
    const trash = thread.getByRole("button", { name: /Delete comment by/ }).first();
    await expect(trash).toBeVisible();
    const restOpacity = await trash.evaluate((el) =>
      Number(getComputedStyle(el).opacity),
    );
    expect(restOpacity).toBeGreaterThan(0.4);

    // (2) Opening the confirm gives the Delete / Cancel buttons room — they fit
    // within the popover (no horizontal overflow past its right edge) on a narrow
    // viewport, and both are visible + tappable.
    await trash.tap();
    const deleteBtn = thread.getByRole("button", { name: "Delete", exact: true });
    const cancelBtn = thread.getByRole("button", { name: "Cancel", exact: true });
    await expect(deleteBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();

    const overflow = await thread.evaluate((popup) => {
      const popupRect = popup.getBoundingClientRect();
      const buttons = Array.from(
        popup.querySelectorAll("button"),
      ).filter((b) => /^(Delete|Cancel)$/.test(b.textContent?.trim() ?? ""));
      // Largest amount any confirm button spills past the popup's right edge.
      return Math.max(
        0,
        ...buttons.map((b) => b.getBoundingClientRect().right - popupRect.right),
      );
    });
    expect(overflow).toBeLessThanOrEqual(1);

    // Cancel backs out without deleting; the comment remains.
    await cancelBtn.tap();
    await expect(thread.getByText("Delete?")).toBeHidden();
    await expect(thread).toContainText("Discover me on mobile.");
  });

  test("owner: resolve still works alongside the delete control", async ({ page }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Rosa Resolver");

    await seedComment(page, doc.slug, SENTENCE_A, "Resolve this thread.");
    await reloadDoc(page);

    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
    await anyBadge(page).first().click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();

    // Both the Resolve toggle and the delete control coexist.
    await expect(thread.getByRole("button", { name: /Delete comment by/ })).toHaveCount(1);
    const resolveBtn = thread.getByRole("button", { name: "Resolve", exact: true });
    await expect(resolveBtn).toBeVisible();
    await resolveBtn.click();

    await expect(thread.getByRole("button", { name: "Reopen", exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(thread).toContainText("Resolved");
  });
});
