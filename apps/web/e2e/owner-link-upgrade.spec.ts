/**
 * Regression: opening the OWNER link after already redeeming the REVIEWER link in the
 * same browser must open the OWNER view — not silently keep the (stale) reviewer
 * session. The viewer's existing name is reused to redeem the owner token seamlessly
 * (no second gate prompt).
 */

import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

const CONTENT = ["# Owner Upgrade Doc", "", "## Body", "", "Some reviewable text here.", ""].join(
  "\n",
);

const toPath = (url: string) => url.slice(url.indexOf("/d/"));

async function redeem(page: Page, path: string, name: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Owner Upgrade Doc", level: 1 })).toBeVisible();
}

test("owner link after a reviewer session upgrades to the owner view", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, "asserts the desktop owner pill controls");

  const doc = await seedDocument(page.request, {
    title: "Owner Upgrade Doc",
    content: CONTENT,
    password: "test-password",
  });

  // 1) Redeem the REVIEWER link first → reviewer session, no owner controls.
  await redeem(page, toPath(doc.shareUrl), "Sam Switcher");
  const pill = page.getByRole("navigation", { name: "Document actions" });
  await expect(pill).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy AI agent read link" })).toHaveCount(0);

  // 2) Open the OWNER link in a NEW tab of the SAME context — the reviewer session
  //    cookie persists (as after closing/reopening a tab), and a fresh document load
  //    processes the owner fragment. It must upgrade to the owner view WITHOUT a
  //    second gate prompt (the existing name is reused).
  const ownerTab = await page.context().newPage();
  await ownerTab.goto(toPath(doc.ownerUrl));
  await expect(
    ownerTab.getByRole("heading", { name: "Owner Upgrade Doc", level: 1 }),
  ).toBeVisible();
  await expect(ownerTab.getByRole("heading", { name: "Welcome" })).toHaveCount(0); // no re-gate
  const ownerPill = ownerTab.getByRole("navigation", { name: "Document actions" });
  await expect(ownerPill.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
  await ownerTab.close();
});
