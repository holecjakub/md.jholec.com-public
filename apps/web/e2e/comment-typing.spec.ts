import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #35 — typing into the comment inputs must be stable on BOTH desktop and mobile:
 * the field/composer must not jump around while text is entered (the mobile input
 * was reported to occasionally jump). We type multi-line text and assert the
 * composer's top edge stays put (it may grow downward, but must not lurch), and
 * capture before/after screenshots as review artifacts.
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
const LONG_TEXT = [
  "This is the first line of a fairly long comment.",
  "Here is a second line to grow the field.",
  "And a third line to make sure nothing jumps.",
].join("\n");

async function createDoc(page: Page) {
  const doc = await seedDocument(page.request, {
    title: "Typing Doc",
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

function selectionComposer(page: Page) {
  return page.getByRole("dialog", { name: "Add a comment on the selected text" });
}

function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

async function topOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top) : NaN;
  }, selector);
}

test.describe("Comment typing stability", () => {
  test("add-comment composer stays anchored while typing a multi-line comment", async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name; // desktop | mobile
    const doc = await createDoc(page);
    await redeem(page, doc.ownerPath, "Tess Typer");

    await expect
      .poll(
        async () => {
          if (await selectionComposer(page).isVisible()) return true;
          await selectTextInPreview(page, QUOTE);
          return selectionComposer(page).isVisible();
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const textarea = selectionComposer(page).getByRole("textbox", {
      name: "Add a comment…",
    });
    await expect(textarea).toBeVisible();

    // Font must be >=16px (no iOS zoom) — the root cause of the mobile jump.
    const fontPx = await textarea.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );
    if (project === "mobile") expect(fontPx).toBeGreaterThanOrEqual(16);

    const popupSel = '[aria-label="Add a comment on the selected text"]';
    const topBefore = await topOf(page, popupSel);
    await page.screenshot({
      path: testInfo.outputPath("composer-before-typing.png"),
    });

    await textarea.click();
    await textarea.fill(LONG_TEXT);
    await expect(textarea).toHaveValue(LONG_TEXT);
    await page.screenshot({
      path: testInfo.outputPath("composer-after-typing.png"),
    });

    // The composer is anchored ABOVE/at the selection; as the field grows it must
    // not lurch upward/downward by a large amount. Allow generous slack for the
    // natural growth, but a "jump" (>120px) would be a regression.
    const topAfter = await topOf(page, popupSel);
    expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(120);
  });

  test("thread reply field stays anchored while typing a multi-line reply", async ({
    page,
  }, testInfo) => {
    const doc = await createDoc(page);
    await redeem(page, doc.ownerPath, "Tess Typer");

    // Seed a comment so a thread exists, then open it via its badge.
    const blockId = await page.evaluate((s) => {
      const el = Array.from(document.querySelectorAll("[data-block-id]")).find((b) =>
        (b.textContent ?? "").includes(s),
      );
      return el?.getAttribute("data-block-id") ?? null;
    }, QUOTE);
    await page.request.post(`/api/d/${doc.slug}/comments`, {
      data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: "Root." },
    });
    await page.reload();
    const badge = page.locator('button[aria-label*="comment thread"]').first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await badge.click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();

    // Reveal the reply field on mobile (hidden behind a Reply button).
    const replyBox = thread.getByRole("textbox", { name: "Reply…" });
    if (!(await replyBox.isVisible())) {
      await thread.getByRole("button", { name: "Reply" }).click();
    }
    await expect(replyBox).toBeVisible();

    const popupSel = '[aria-label="Comment thread"]';
    const topBefore = await topOf(page, popupSel);
    await page.screenshot({ path: testInfo.outputPath("reply-before-typing.png") });

    await replyBox.click();
    await replyBox.fill(LONG_TEXT);
    await expect(replyBox).toHaveValue(LONG_TEXT);
    await page.screenshot({ path: testInfo.outputPath("reply-after-typing.png") });

    const topAfter = await topOf(page, popupSel);
    expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(120);
  });
});
