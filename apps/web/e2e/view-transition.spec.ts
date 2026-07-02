import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #34 — the Preview↔Code transition (a geometry-neutral spring fade: opacity +
 * blur). The critical guarantee: it animates ONLY opacity/filter (never a
 * transform), so comment pins/underlines do not drift after toggling back.
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
    title: "Transition Doc",
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

async function toggle(page: Page, name: "Preview" | "Code") {
  const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
  if (!isDesktop) {
    const fab = page.getByRole("button", { name: "Document actions" });
    if (await fab.isVisible()) await fab.tap();
  }
  await page.getByRole("button", { name }).click();
}

test("toggling Preview↔Code spring-fades without drifting comment pins", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");

  // Seed a comment so there's a badge whose position we can compare.
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
  const before = await badge.boundingBox();
  expect(before).not.toBeNull();

  // → Code: the source view is shown.
  await toggle(page, "Code");
  await expect(page.locator("pre")).toBeVisible();
  await expect(page.getByText("Markdown source")).toBeVisible();

  // → back to Preview: the badge returns at the same position (no drift from a
  // lingering transform). Allow a couple px for sub-pixel/layout rounding.
  await toggle(page, "Preview");
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => {
      const b = await badge.boundingBox();
      if (!b || !before) return 999;
      return Math.max(Math.abs(b.x - before.x), Math.abs(b.y - before.y));
    })
    .toBeLessThanOrEqual(3);
});
