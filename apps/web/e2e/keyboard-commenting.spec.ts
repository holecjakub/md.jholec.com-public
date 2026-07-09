import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * B1 (WCAG 2.1.1, Level A) — comment creation must be operable with the
 * keyboard alone. Every [data-block-id] block is in the tab order; focusing one
 * reveals a visible "Comment on this block" affordance, and the documented C
 * hotkey opens the composer anchored to the whole block. axe cannot catch a
 * pointer-only flow, so this is a real end-to-end keyboard walk: Tab → focus a
 * block → C → type → Enter → the comment lands.
 */

const CONTENT = [
  "# Keyboard Doc",
  "",
  "First paragraph of the document, reachable and commentable by keyboard alone.",
  "",
  "Second paragraph proving focus moves block by block through the preview.",
  "",
].join("\n");

async function createAndOpen(page: Page, name: string) {
  const doc = await seedDocument(page.request, {
    title: "Keyboard Doc",
    content: CONTENT,
    password: "test-password",
  });
  await page.goto(doc.ownerUrl.slice(doc.ownerUrl.indexOf("/d/")));
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Keyboard Doc", level: 1 })).toBeVisible();
  return doc;
}

test("a keyboard-only user can reach a block, see the affordance, and post a comment", async ({
  page,
}) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) < 768,
    "keyboard-only operation is exercised on the desktop project",
  );

  await createAndOpen(page, "Kai Keyboard");

  // Tab until a preview block holds focus — a bounded REAL keyboard walk, so
  // this proves reachability through the actual tab order (not element.focus()).
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        el instanceof HTMLElement &&
        el.hasAttribute("data-block-id") &&
        !el.classList.contains("md-comment-highlight")
      );
    });
  }
  expect(reached, "a [data-block-id] block is reachable via Tab").toBe(true);

  // Focusing the block reveals the visible affordance with the documented key.
  const affordance = page.getByRole("button", { name: /Comment on this block/ });
  await expect(affordance).toBeVisible();

  // The hotkey opens the composer anchored to the whole block…
  await page.keyboard.press("c");
  const composer = page.getByRole("dialog", { name: "Add a comment on the selected text" });
  await expect(composer).toBeVisible();

  // …with the field focused: a keyboard user has no pointer to click into it.
  const textarea = composer.getByRole("textbox", { name: "Add a comment…" });
  await expect(textarea).toBeFocused();

  await page.keyboard.type("Posted with the keyboard only.");
  await page.keyboard.press("Enter");
  await expect(composer).toBeHidden();

  // The comment landed: the block gains its margin badge.
  await expect(page.locator('button[aria-label*="comment thread"]').first()).toBeVisible();
});
