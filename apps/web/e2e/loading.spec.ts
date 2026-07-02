import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * #29 — the document loader must stay up until the comments' INITIAL fetch
 * resolves, so the page is never revealed half-loaded (content first, then badges
 * popping in a beat later). We delay the comments GET and assert the loader holds
 * (and badges are absent) until it returns.
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
    title: "Loading Doc",
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

test("loader stays until comments finish loading (no half-loaded reveal)", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");

  // Seed a comment so there is a badge to wait for once comments load.
  const blockId = await page.evaluate((s) => {
    const el = Array.from(document.querySelectorAll("[data-block-id]")).find((b) =>
      (b.textContent ?? "").includes(s),
    );
    return el?.getAttribute("data-block-id") ?? null;
  }, QUOTE);
  expect(blockId).toBeTruthy();
  const seed = await page.request.post(`/api/d/${doc.slug}/comments`, {
    data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: "Root." },
  });
  expect(seed.status()).toBe(201);

  // Delay only the comments GET so we can observe the loader holding.
  await page.route("**/comments", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  await page.reload();

  // While the comments GET is in flight, the loader overlay is up and NO badge
  // has rendered yet (the doc is not revealed half-loaded).
  await expect(page.getByText("Loading document…")).toBeVisible();
  await expect(page.locator('button[aria-label*="comment thread"]')).toHaveCount(0);

  // Once comments resolve, the loader clears and the badge appears together.
  await expect(page.getByText("Loading document…")).toBeHidden({ timeout: 6000 });
  await expect(
    page.locator('button[aria-label*="comment thread"]').first(),
  ).toBeVisible({ timeout: 6000 });
});

test("reacting and posting do not error where haptics are unsupported (#31 graceful no-op)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");
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

  // Open the thread via the margin badge (reliable on both desktop and mobile;
  // tapping the inline underline on mobile can start a text selection instead).
  const badge = page.locator('button[aria-label*="comment thread"]').first();
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await badge.click();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread).toBeVisible();

  // React (fires haptic()) — optimistic pill appears, and no uncaught error from
  // the haptic bridge on an unsupported platform.
  await thread.getByRole("button", { name: "React: Looks good" }).click();
  await expect(
    thread.getByRole("button", { name: "Remove your Looks good reaction" }),
  ).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join("\n")).toEqual([]);
});

test("loader stays pinned to the viewport center (no jump) — #36", async ({ page }) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");
  const blockId = await page.evaluate((s) => {
    const el = Array.from(document.querySelectorAll("[data-block-id]")).find((b) =>
      (b.textContent ?? "").includes(s),
    );
    return el?.getAttribute("data-block-id") ?? null;
  }, QUOTE);
  await page.request.post(`/api/d/${doc.slug}/comments`, {
    data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: "Root." },
  });

  // Hold the comments fetch so the in-document loader overlay is visible.
  await page.route("**/comments", async (route) => {
    if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.reload();

  const loader = page.getByRole("status");
  await expect(loader).toBeVisible();
  // Its center sits at the viewport center (fixed inset-0 + flex centering), so it
  // can't jump between load phases.
  const vp = page.viewportSize()!;
  const box = await loader.boundingBox();
  expect(box).not.toBeNull();
  const centerY = box!.y + box!.height / 2;
  const centerX = box!.x + box!.width / 2;
  expect(Math.abs(centerY - vp.height / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(centerX - vp.width / 2)).toBeLessThanOrEqual(2);
});
