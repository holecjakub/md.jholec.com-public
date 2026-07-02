import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #32 — while the add-comment composer is open, the selected text stays visibly
 * highlighted (a persistent overlay, since the native selection clears once the
 * composer's textarea takes focus), and the composer mirrors the thread-detail
 * design (an elevated container with a page-coloured boxed input).
 */

const CONTENT = [
  "# Quarterly Report",
  "",
  "## Summary",
  "",
  "Highlights of the quarter are summarized in this opening paragraph for review.",
  "",
].join("\n");

const QUOTE = "Highlights of the quarter";

async function createDoc(page: Page) {
  const doc = await seedDocument(page.request, {
    title: "Selection Doc",
    content: CONTENT,
    password: "test-password",
  });
  return { slug: doc.slug, ownerPath: doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/")) };
}

async function redeem(page: Page, path: string, name: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Loading document…")).toBeHidden({ timeout: 10_000 });
}

async function selectTextInPreview(page: Page, text: string) {
  return page.evaluate((needle) => {
    const container = document.querySelector(".md-prose");
    if (!container) return false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walker.nextNode()) {
      const c = walker.currentNode as Text;
      if (c.textContent && c.textContent.includes(needle)) {
        node = c;
        break;
      }
    }
    if (!node || !node.textContent) return false;
    const start = node.textContent.indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + needle.length);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const blockEl =
      (node.parentElement?.closest("[data-block-id]") as HTMLElement | null) ??
      (container as HTMLElement);
    const rect = range.getBoundingClientRect();
    blockEl.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
    return true;
  }, text);
}

function composer(page: Page) {
  return page.getByRole("dialog", { name: "Add a comment on the selected text" });
}

async function openComposerFromSelection(page: Page) {
  await expect
    .poll(
      async () => {
        if (await composer(page).isVisible()) return true;
        await selectTextInPreview(page, QUOTE);
        return composer(page).isVisible();
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function delayCommentPost(page: Page, slug: string, delayMs = 1000) {
  await page.route(`**/api/d/${slug}/comments`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const data = route.request().postDataJSON() as {
      anchor?: unknown;
      body?: unknown;
    };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        comment: {
          id: `test-comment-${Date.now()}`,
          document_id: "test-document",
          version_id: "test-version",
          participant_id: "test-participant",
          anchor: data.anchor,
          body: data.body,
          parent_id: null,
          status: "open",
          created_at: new Date().toISOString(),
          author_name: "You",
          reactions: [],
        },
      }),
    });
  });
}

test("selection stays highlighted while the composer is open, and clears on dismiss", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");

  // Surface the composer (selection → composer is timing-sensitive; poll).
  await openComposerFromSelection(page);

  // The composer carries a page-coloured boxed input (thread-detail design).
  await expect(composer(page).getByRole("textbox", { name: "Add a comment…" })).toBeVisible();

  // The selected text is highlighted by a persistent overlay even though the
  // textarea now holds focus (native selection would otherwise be gone).
  const highlight = page.locator("[data-selection-highlight]");
  await expect(highlight.first()).toBeVisible();

  // Dismiss → the persistent highlight is removed.
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeHidden();
  await expect(page.locator("[data-selection-highlight]")).toHaveCount(0);
});

test("desktop selection opens the composer on the first attempt", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, "desktop-only timing regression");

  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Diana Desktop");

  await expect(selectTextInPreview(page, QUOTE)).resolves.toBe(true);
  await expect(composer(page)).toBeVisible();
});

test("desktop REAL mouse drag selects text and surfaces the composer with a highlight", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, "desktop-only real-drag regression");

  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Drew Dragger");

  // A genuine press-drag-release across the opening paragraph. `selectionchange`
  // fires repeatedly mid-drag (steps), so if the composer were surfaced on
  // selectionchange it would autofocus mid-drag, steal focus, and collapse the
  // selection — the regression this guards. The composer must only appear on mouseup,
  // and the persistent highlight overlay must capture a real (non-empty) selection.
  const para = page.locator(".md-prose p", { hasText: QUOTE });
  await expect(para).toBeVisible();
  const box = (await para.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 3 + Math.min(180, box.width - 6), y, { steps: 14 });
  await page.mouse.up();

  // Composer surfaces (only after release) …
  await expect(composer(page)).toBeVisible();
  // … and the overlay reflects a real, non-collapsed selection (meaningful width).
  const highlight = page.locator("[data-selection-highlight]").first();
  await expect(highlight).toBeVisible();
  const hlBox = (await highlight.boundingBox())!;
  expect(hlBox.width).toBeGreaterThan(8);
});

test("opening the composer on a selection does not scroll the page", async ({ page }) => {
  // A tall document so there is scroll room and the selection sits below the fold —
  // the condition under which the textarea's autofocus used to yank the page.
  const lines = ["# Tall Doc", ""];
  for (let i = 0; i < 40; i++) {
    lines.push(`Paragraph ${i} with filler text so the document is tall enough to scroll.`, "");
  }
  const seeded = await seedDocument(page.request, {
    title: "Tall Doc",
    content: lines.join("\n"),
    password: "test-password",
  });
  await page.goto(seeded.ownerUrl.slice(seeded.ownerUrl.indexOf("/d/")));
  await page.getByLabel("Name").fill("Sky Scroller");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Tall Doc", level: 1 })).toBeVisible();

  // Scroll down, then select a sentence near the bottom of the viewport.
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.scrollY);

  await selectTextInPreview(page, "Paragraph 22 with filler text");
  await expect(composer(page)).toBeVisible();

  // The composer's autofocus must NOT move the viewport (preventScroll).
  const after = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});

test("document tab title uses the loaded document title", async ({ page }) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Tina Title");

  await expect(page).toHaveTitle("Selection Doc - md.jholec.com");
});

test("submitting a selected-text comment closes the composer before the network finishes", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Casey Commenter");

  await openComposerFromSelection(page);
  await composer(page).getByRole("textbox", { name: "Add a comment…" }).fill("Close right away.");

  await delayCommentPost(page, doc.slug);

  await composer(page).getByRole("button", { name: "Comment" }).click();
  await expect(composer(page)).toBeHidden();
  await page.unroute(`**/api/d/${doc.slug}/comments`);
});

test("submitting a selected-text emoji closes the composer before the network finishes", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Emery Emoji");

  await openComposerFromSelection(page);

  await delayCommentPost(page, doc.slug);

  await composer(page).getByRole("button", { name: "Looks good" }).click();
  await expect(composer(page)).toBeHidden();
  await page.unroute(`**/api/d/${doc.slug}/comments`);
});

test("a failed comment post shows an error toast with Retry; the optimistic comment rolls back and retry succeeds", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Faye Fail");

  // Fail the FIRST POST /comments, then let subsequent ones hit the real API.
  let failedOnce = false;
  await page.route(`**/api/d/${doc.slug}/comments`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if (!failedOnce) {
      failedOnce = true;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Server error" }),
      });
    }
    return route.fallback();
  });

  const badge = page.locator('button[aria-label*="comment thread"]');

  await openComposerFromSelection(page);
  await composer(page).getByRole("textbox", { name: "Add a comment…" }).fill("Retry me");
  await composer(page).getByRole("button", { name: "Comment" }).click();

  // Failure surfaces as an alert toast with a Retry action; the optimistic comment
  // rolled back (no lingering badge), instead of failing silently.
  const toast = page.getByRole("alert").filter({ hasText: "post your comment" });
  await expect(toast).toBeVisible();
  await expect(badge).toHaveCount(0);

  // Retry re-runs the post; this time it reaches the real API and the comment lands.
  await toast.getByRole("button", { name: "Retry" }).click();
  await expect(badge.first()).toBeVisible();

  await page.unroute(`**/api/d/${doc.slug}/comments`);
});
