import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #21 (part 2) — comments are visible and actionable in the Code (raw markdown)
 * view, not only the Preview: anchored quotes highlight inline and open the same
 * thread popover (reply/react).
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
    title: "Code Comments Doc",
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

async function toggleCode(page: Page) {
  const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
  if (!isDesktop) {
    await page.getByRole("button", { name: "Document actions" }).tap();
  }
  await page.getByRole("button", { name: "Code" }).click();
  await expect(page.locator("pre")).toBeVisible();
}

test("Code view shows anchored comments and opens the thread on click", async ({ page }) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");

  const blockId = await page.evaluate((s) => {
    const el = Array.from(document.querySelectorAll("[data-block-id]")).find((b) =>
      (b.textContent ?? "").includes(s),
    );
    return el?.getAttribute("data-block-id") ?? null;
  }, QUOTE);
  await page.request.post(`/api/d/${doc.slug}/comments`, {
    data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: "Cite this in code view." },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();

  await toggleCode(page);

  // The quote is highlighted inline in the raw source.
  const highlight = page.locator("pre [data-code-comment]").filter({ hasText: QUOTE });
  await expect(highlight.first()).toBeVisible({ timeout: 10_000 });

  // Clicking it opens the same thread popover with the comment.
  await highlight.first().click();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread).toBeVisible();
  await expect(thread).toContainText("Cite this in code view.");

  // The thread is interactive here too (reaction toggles).
  await thread.getByRole("button", { name: "React: Looks good" }).click();
  await expect(
    thread.getByRole("button", { name: "Remove your Looks good reaction" }),
  ).toBeVisible({ timeout: 10_000 });
});
