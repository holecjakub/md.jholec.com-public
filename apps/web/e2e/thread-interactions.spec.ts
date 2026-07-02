import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Thread-interaction behaviours:
 * - #24 the reply input renders at ≥16px on mobile so iOS Safari does not auto-zoom
 *   (which jerked the viewport) when it is focused.
 * - #26 on mobile the reply input is hidden behind a Reply button (inline with the
 *   reactions) and revealed on tap; on desktop it is visible immediately.
 * - #25 adding a reply renders it in the thread (the new row animates in, but here
 *   we assert the functional outcome — the motion wrapper must not break rendering).
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
    title: "Thread UX Doc",
    content: CONTENT,
    password: "test-password",
  });
  const toPath = (u: string) => u.slice(u.indexOf("/d/"));
  return { slug: doc.slug, ownerPath: toPath(doc.ownerUrl) };
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

async function seedComment(page: Page, slug: string, body: string) {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, QUOTE);
  if (!blockId) throw new Error("no block for quote");
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body },
  });
  expect(res.status(), await res.text()).toBe(201);
}

function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

async function openThread(page: Page) {
  const underline = page.locator("span.md-comment-highlight").first();
  await expect(underline).toBeVisible({ timeout: 10_000 });
  await underline.click();
  const thread = threadPopover(page);
  await expect(thread).toBeVisible();
  return thread;
}

/** Open a doc as owner with one seeded comment, ready to interact with its thread. */
async function setup(page: Page) {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");
  await seedComment(page, doc.slug, "The root comment.");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();
  return doc;
}

test.describe("Thread interactions", () => {
  test("mobile: reply input is ≥16px (no iOS auto-zoom) once revealed", async ({
    page,
  }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) >= 768,
      "iOS auto-zoom only affects the small/mobile viewport",
    );
    await setup(page);
    const thread = await openThread(page);

    // Reply field is hidden on mobile until the Reply button is tapped.
    await thread.getByRole("button", { name: "Reply" }).tap();
    const replyBox = thread.getByRole("textbox", { name: "Reply…" });
    await expect(replyBox).toBeVisible();

    const fontPx = await replyBox.evaluate(
      (el) => parseFloat(getComputedStyle(el).fontSize),
    );
    expect(fontPx).toBeGreaterThanOrEqual(16);
  });

  test("mobile hides the reply input behind a Reply button; desktop shows it immediately", async ({
    page,
  }) => {
    await setup(page);
    const thread = await openThread(page);
    const replyBox = thread.getByRole("textbox", { name: "Reply…" });
    const isMobile = (page.viewportSize()?.width ?? 0) < 768;

    if (isMobile) {
      // Hidden until revealed; the inline Reply button does the reveal.
      await expect(replyBox).toBeHidden();
      const replyButton = thread.getByRole("button", { name: "Reply" });
      await expect(replyButton).toBeVisible();
      await replyButton.tap();
      await expect(replyBox).toBeVisible();
    } else {
      // Desktop: the field is there from the start (no reveal step).
      await expect(replyBox).toBeVisible();
    }
  });

  test("adding a reply renders it in the thread", async ({ page }) => {
    await setup(page);
    const thread = await openThread(page);
    const isMobile = (page.viewportSize()?.width ?? 0) < 768;
    if (isMobile) {
      await thread.getByRole("button", { name: "Reply" }).tap();
    }
    const replyBox = thread.getByRole("textbox", { name: "Reply…" });
    await replyBox.click();
    await replyBox.fill("A spring-animated reply.");
    await thread.getByRole("button", { name: "Reply" }).click();
    await expect(thread).toContainText("A spring-animated reply.", { timeout: 10_000 });
    // The composer remains for further replies.
    await expect(replyBox).toBeVisible();
  });
});
