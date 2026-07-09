import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Batch-B (perf keystone refactor) regression proofs. These tests assert the
 * OBSERVABLES the refactor promises, not just end-state correctness:
 *
 *  1. Structural sharing + incremental highlight diff (C3/H3): a reaction on
 *     one thread must not detach ANY highlight span (same DOM nodes before and
 *     after), must not move the other thread's badge, and must not trigger a
 *     single TreeWalker text-walk (the relocation cache absorbs the pass).
 *  2. Delta refetch (C4/H9): the reaction's reconcile is a single-comment GET —
 *     never a full-list GET.
 *  3. Imperative hover emphasis (H7) + re-stamp after span rebuild (invariant
 *     L5-2): hovering a badge stamps data-emphasized on the span AND the badge;
 *     a realtime status flip that rewraps the span mid-hover re-stamps the
 *     fresh span.
 *  4. Geometry-only resize path (H6): resizing re-positions badges without
 *     detaching highlight spans; restoring the viewport restores the badge to
 *     its original position (no drift).
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
  SENTENCE_A,
  "",
  SENTENCE_B,
  "",
].join("\n");

interface CreatedDoc {
  slug: string;
  inviteUrl: string;
  ownerUrl: string;
}

async function createDocument(page: Page): Promise<CreatedDoc> {
  const doc = await seedDocument(page.request, {
    title: "QA Batch-B Doc",
    content: MARKDOWN_CONTENT,
    password: "test-password",
  });
  const toPath = (url: string) => url.slice(url.indexOf("/d/"));
  return { slug: doc.slug, inviteUrl: toPath(doc.shareUrl), ownerUrl: toPath(doc.ownerUrl) };
}

async function redeemAndOpen(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
}

async function seedComment(page: Page, slug: string, sentence: string, body: string) {
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
  return created.comment.id;
}

function anyBadge(page: Page) {
  return page.locator('button[aria-label*="comment thread"]');
}

function anyHighlight(page: Page) {
  return page.locator("span.md-comment-highlight");
}

function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

/** Stash the current highlight spans on window so a later pass can compare identity. */
async function stashSpans(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __qaSpans?: Element[] };
    w.__qaSpans = Array.from(document.querySelectorAll("span.md-comment-highlight"));
    return w.__qaSpans.length;
  });
}

/** True when the DOM's highlight spans are the SAME nodes as the stashed set. */
async function spansKeptIdentity(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { __qaSpans?: Element[] };
    const now = Array.from(document.querySelectorAll("span.md-comment-highlight"));
    const before = w.__qaSpans ?? [];
    return (
      now.length === before.length &&
      now.every((el, i) => el === before[i] && el.isConnected)
    );
  });
}

test.describe("Batch B — structural sharing / delta refetch / imperative hover", () => {
  test("reaction: delta GET only, zero span detach, zero text re-walk, other badge does not move", async ({
    page,
  }) => {
    // Count every TreeWalker construction — relocation (rangeFromOffsets) and
    // highlight wrapping both walk text via createTreeWalker, so a zero delta
    // proves the relocation cache + incremental diff absorbed the mutation.
    await page.addInitScript(() => {
      const w = window as unknown as { __twCount: number };
      w.__twCount = 0;
      const orig = Document.prototype.createTreeWalker;
      Document.prototype.createTreeWalker = function (...args: unknown[]) {
        (window as unknown as { __twCount: number }).__twCount += 1;
        return (orig as (...a: unknown[]) => TreeWalker).apply(this, args);
      } as typeof Document.prototype.createTreeWalker;
    });

    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");
    await seedComment(page, doc.slug, SENTENCE_A, "First thread.");
    await seedComment(page, doc.slug, SENTENCE_B, "Second thread.");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
    await expect(anyBadge(page)).toHaveCount(2, { timeout: 10_000 });
    await expect(anyHighlight(page)).toHaveCount(2, { timeout: 10_000 });

    // Sanity: the underline wraps exactly the anchored sentence, and the badge
    // sits vertically on its block (pin at the right place).
    await expect(anyHighlight(page).first()).toHaveText(SENTENCE_A);
    const spanBoxA = await anyHighlight(page).first().boundingBox();
    const badgeBoxA = await anyBadge(page).first().boundingBox();
    expect(spanBoxA && badgeBoxA).toBeTruthy();
    expect(Math.abs(badgeBoxA!.y - spanBoxA!.y)).toBeLessThan(60);

    expect(await stashSpans(page)).toBe(2);
    const badgeBoxB = await anyBadge(page).nth(1).boundingBox();

    const listGets: string[] = [];
    const deltaGets: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET") return;
      const pathname = new URL(req.url()).pathname;
      if (pathname === `/api/d/${doc.slug}/comments`) listGets.push(pathname);
      else if (pathname.startsWith(`/api/d/${doc.slug}/comments/`)) deltaGets.push(pathname);
    });
    const walkersBefore = await page.evaluate(
      () => (window as unknown as { __twCount: number }).__twCount,
    );

    // React on the FIRST thread from its popover.
    await anyBadge(page).first().click();
    const popover = threadPopover(page);
    await expect(popover).toContainText("First thread.");
    await popover.getByRole("button", { name: "React: Looks good" }).first().click();
    await expect(
      popover.getByRole("button", { name: "Remove your Looks good reaction" }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    // The badge summary reflects the reaction (state really updated).
    await expect(anyBadge(page).first()).toContainText("1", { timeout: 10_000 });
    // Let any realtime echo of our own mutation flush through the delta queue.
    await page.waitForTimeout(1_000);

    const walkersAfter = await page.evaluate(
      () => (window as unknown as { __twCount: number }).__twCount,
    );

    expect(listGets, "a reaction must never trigger a full-list GET").toEqual([]);
    expect(deltaGets.length, "the reaction reconcile must be a single-comment GET").toBeGreaterThan(0);
    expect(
      await spansKeptIdentity(page),
      "no highlight span may be detached by an unrelated mutation",
    ).toBe(true);
    const badgeBoxBAfter = await anyBadge(page).nth(1).boundingBox();
    expect(badgeBoxBAfter!.y, "the untouched thread's badge must not move").toBe(badgeBoxB!.y);
    expect(
      walkersAfter - walkersBefore,
      "a reaction must not re-walk any block text (relocation cache hit)",
    ).toBe(0);
  });

  test("hover emphasis is stamped imperatively and re-stamps after a realtime span rebuild (L5-2)", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "hover emphasis is a pointer affordance — desktop only");

    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");
    const commentId = await seedComment(page, doc.slug, SENTENCE_A, "Resolve me mid-hover.");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
    const badge = anyBadge(page).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(anyHighlight(page).first()).toBeVisible({ timeout: 10_000 });

    // Hover the badge → the block's underline AND the badge itself light up.
    await badge.hover();
    await expect(
      page.locator('span.md-comment-highlight[data-emphasized="true"]'),
    ).toHaveCount(1);
    await expect(badge).toHaveAttribute("data-emphasized", "true");

    await stashSpans(page);

    // Resolve the thread OUT OF BAND (page.request bypasses the page's JS), so
    // the page only learns about it via the realtime broadcast → delta GET →
    // signature change → span rewrap. The pointer never moves off the badge.
    const res = await page.request.patch(`/api/d/${doc.slug}/comments/${commentId}`, {
      data: { status: "resolved" },
    });
    expect(res.status(), await res.text()).toBe(200);

    // The rebuilt span carries the resolved style...
    await expect(
      page.locator('span.md-comment-highlight[data-resolved="true"]'),
    ).toHaveCount(1, { timeout: 15_000 });
    // ...is a NEW node (the rewrap really happened — this test exercises the
    // re-stamp path, not a no-op)...
    expect(await spansKeptIdentity(page)).toBe(false);
    // ...and the emphasis was re-stamped onto it while the badge stayed hovered
    // (invariant L5-2: hover-emphasis survives ANY span rebuild).
    await expect(
      page.locator('span.md-comment-highlight[data-emphasized="true"]'),
    ).toHaveCount(1);
    await expect(badge).toHaveAttribute("data-resolved", "true", { timeout: 10_000 });

    // Un-hover clears the stamps.
    await page.mouse.move(0, 0);
    await expect(
      page.locator('span.md-comment-highlight[data-emphasized="true"]'),
    ).toHaveCount(0);
    await expect(badge).not.toHaveAttribute("data-emphasized", "true");
  });

  test("resize: badges reposition without detaching spans; restoring the viewport restores the pin (no drift)", async ({
    page,
  }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");
    await seedComment(page, doc.slug, SENTENCE_A, "Pin under resize.");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
    const badge = anyBadge(page).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(anyHighlight(page).first()).toBeVisible({ timeout: 10_000 });

    const original = page.viewportSize();
    test.skip(!original, "no viewport metadata");
    const originalBox = await badge.boundingBox();
    await stashSpans(page);

    // Shrink → geometry-only pass: the badge may move, the spans must not be
    // touched (a resize never re-runs text relocation, so no detach is possible).
    await page.setViewportSize({ width: 560, height: original!.height });
    await page.waitForTimeout(300);
    expect(await spansKeptIdentity(page)).toBe(true);
    await expect(badge).toBeVisible();

    // Restore → the pin returns to exactly its original spot (no drift).
    await page.setViewportSize(original!);
    await page.waitForTimeout(300);
    expect(await spansKeptIdentity(page)).toBe(true);
    const restoredBox = await badge.boundingBox();
    expect(restoredBox!.x).toBe(originalBox!.x);
    expect(restoredBox!.y).toBe(originalBox!.y);
  });
});
