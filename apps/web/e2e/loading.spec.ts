import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Loading behavior. The initial comments ship EMBEDDED in the document payload
 * (perf H1), so the document + its badges reveal together as soon as the doc
 * arrives — there is no second sequential comments round trip and no
 * overlay-until-comments phase. We hold the comments GET (only realtime/mutation
 * refetches hit it now) and assert the badge still renders promptly.
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

test("badges render from the embedded payload without a second comments round trip", async ({
  page,
}) => {
  const doc = await createDoc(page);
  await redeem(page, doc.ownerPath, "Olivia Owner");

  // Seed a comment so there is a badge to wait for.
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

  // Hold any comments GET far beyond the assertion window. Only realtime/
  // mutation refetches hit this endpoint now — the initial list is embedded in
  // the document payload, so the badge must appear without waiting for it.
  await page.route("**/comments", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((r) => setTimeout(r, 15_000));
    }
    await route.continue().catch(() => {});
  });

  await page.reload();

  // The badge renders together with the document, while the comments GET (if
  // any fired) is still being held.
  await expect(
    page.locator('button[aria-label*="comment thread"]').first(),
  ).toBeVisible({ timeout: 10_000 });

  await page.unrouteAll({ behavior: "ignoreErrors" });
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

  // Hold the DOCUMENT fetch so the session-check loader is observable. (The
  // comments no longer gate the reveal — they ship inside this same payload.)
  await page.route(`**/api/d/${doc.slug}`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
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

  await page.unrouteAll({ behavior: "ignoreErrors" });
});
