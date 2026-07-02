import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #38 — the right-margin badge is responsive: it caps at 2 avatars on mobile
 * (the rest collapse into a "+N" pill) vs 3 on desktop, and shows fewer summary
 * emoji on mobile, so it stays slim and never bleeds into the prose.
 */
const CONTENT = "# Quarterly Report\n\n## Summary\n\nHighlights of the quarter are summarized in this opening paragraph for review.\n";
const QUOTE = "Highlights of the quarter";

async function redeem(p: Page, path: string, name: string) {
  await p.goto(path);
  await expect(p.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await p.getByLabel("Name").fill(name);
  await p.getByRole("button", { name: "View document" }).click();
  await expect(p.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
}

test("badge caps avatars by screen size: +2 on mobile, +1 on desktop (4 commenters)", async ({
  page,
  browser,
}) => {
  const b = await seedDocument(page.request, {
    title: "Badge Doc",
    content: CONTENT,
    password: "test-password",
  });
  const toPath = (u: string) => u.slice(u.indexOf("/d/"));

  // Four distinct commenters on the same quote.
  for (const name of ["Alice Adams", "Bob Brown", "Carol Chen", "Dan Davis"]) {
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    await redeem(rp, toPath(b.shareUrl), name);
    const blockId = await rp.evaluate((s) => {
      const el = Array.from(document.querySelectorAll("[data-block-id]")).find((x) =>
        (x.textContent ?? "").includes(s),
      );
      return el?.getAttribute("data-block-id") ?? null;
    }, QUOTE);
    await rp.request.post(`/api/d/${b.slug}/comments`, {
      data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: `from ${name}` },
    });
    await ctx.close();
  }

  await redeem(page, toPath(b.ownerUrl), "Olivia Owner");
  const badge = page.locator('button[aria-label*="comment thread"]').first();
  await expect(badge).toBeVisible({ timeout: 10_000 });

  const isMobile = (page.viewportSize()?.width ?? 0) < 640;
  // 4 participants − cap → mobile cap 2 ⇒ "+2"; desktop cap 3 ⇒ "+1".
  await expect(badge).toContainText(isMobile ? "+2" : "+1");
  await expect(badge).not.toContainText(isMobile ? "+1" : "+2");
});
