import { test, expect, type Page } from "@playwright/test";
import { seedDocument, expectNoSeriousA11yViolations } from "./_helpers";

/**
 * E2E coverage for the floating ActionBar (replaces the old TopBar):
 * - Desktop: a vertical pill fixed to the right edge, vertically centered, with
 *   the view toggle, theme, help, and (owner) download/share/participants. Labels
 *   appear as tooltips on focus; theme toggles `.dark`; Help opens a popover to
 *   the LEFT and Esc closes; the pill never overlaps a comment badge.
 * - Reviewers do NOT see the owner actions.
 * - Mobile: the desktop pill is hidden; a bottom-right FAB (≥44px) expands into a
 *   labelled action cluster (items ≥44px); Help opens a bottom-sheet dialog.
 *
 * Each test creates its own document via the public API (shared local Supabase,
 * no db reset). This file never touches commenting.spec.ts.
 */

const MARKDOWN_CONTENT = [
  "# Action Bar Spec Doc",
  "",
  "## Overview",
  "",
  "The quick brown fox jumps over the lazy dog in this opening paragraph.",
  "",
  "A second paragraph follows with more text to anchor a comment against.",
  "",
].join("\n");

const ANCHOR_TEXT = "quick brown fox";

interface CreatedDoc {
  slug: string;
  inviteUrl: string;
  ownerUrl: string;
}

async function createDocument(page: Page): Promise<CreatedDoc> {
  const doc = await seedDocument(page.request, {
    title: "E2E ActionBar Doc",
    content: MARKDOWN_CONTENT,
    password: "test-password",
  });
  const toPath = (url: string) => url.slice(url.indexOf("/d/"));
  return {
    slug: doc.slug,
    inviteUrl: toPath(doc.shareUrl),
    ownerUrl: toPath(doc.ownerUrl),
  };
}

async function redeemAndOpen(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();
  await expect(
    page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
  ).toBeVisible();
}

/** Seed a comment via the API so a margin badge renders (for the collision test). */
async function seedComment(page: Page, slug: string, sentence: string): Promise<void> {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, sentence);
  if (!blockId) throw new Error(`seedComment: no block contains "${sentence}"`);
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: sentence, prefix: "", suffix: "", blockId }, body: "Margin badge anchor." },
  });
  expect(res.status(), await res.text()).toBe(201);
}

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 768;

test.describe("ActionBar — floating right pill", () => {
  test("old top bar is gone (no sticky header with a segmented toggle)", async ({ page }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Tom Topbar");

    // No <header> sticky bar above the document anymore.
    await expect(page.locator("header.sticky")).toHaveCount(0);
    // The action bar exists instead — on desktop the right pill, on mobile the FAB.
    if (isDesktop(page)) {
      await expect(page.getByRole("navigation", { name: "Document actions" })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "Document actions" })).toBeVisible();
    }
  });

  test("desktop: pill visible, fixed right + vertically centered, with the actions", async ({
    page,
  }) => {
    test.skip(!isDesktop(page), "desktop-only pill");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Vera Viewer");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    await expect(pill).toBeVisible();

    // Fixed to the right edge and vertically centered.
    const box = (await pill.boundingBox())!;
    const vw = page.viewportSize()!.width;
    const vh = page.viewportSize()!.height;
    expect(vw - (box.x + box.width), "pill hugs the right edge").toBeLessThan(40);
    const center = box.y + box.height / 2;
    expect(Math.abs(center - vh / 2), "pill is vertically centered").toBeLessThan(40);

    // Always-present controls.
    await expect(pill.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect(pill.getByRole("button", { name: "Code" })).toBeVisible();
    await expect(pill.getByRole("button", { name: "Help" })).toBeVisible();
    await expect(pill.getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeVisible();
  });

  test("desktop: tooltip appears on focus to the left", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only tooltips");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Tabby Tabber");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    // Keyboard-focus the Preview button (focus-visible drives the tooltip open).
    await pill.getByRole("button", { name: "Preview" }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");

    // Base UI renders the tooltip body in a portal with data-slot=tooltip-content.
    const tip = page
      .locator('[data-slot="tooltip-content"]')
      .filter({ hasText: "Preview" });
    await expect(tip.first()).toBeVisible({ timeout: 5000 });

    // The tooltip is positioned to the LEFT of the focused button.
    const tipBox = (await tip.first().boundingBox())!;
    const btnBox = (await pill.getByRole("button", { name: "Preview" }).boundingBox())!;
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(btnBox.x + 4);
  });

  test("desktop: view toggle switches Preview ↔ Code", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only pill");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Cody Coder");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    const preview = pill.getByRole("button", { name: "Preview" });
    const code = pill.getByRole("button", { name: "Code" });

    await expect(preview).toHaveAttribute("aria-pressed", "true");

    await code.click();
    await expect(code).toHaveAttribute("aria-pressed", "true");
    await expect(preview).toHaveAttribute("aria-pressed", "false");
    // Code view renders the raw markdown source.
    await expect(page.getByText("# Action Bar Spec Doc")).toBeVisible();

    await preview.click();
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
    ).toBeVisible();
  });

  test("desktop: theme toggles the .dark class", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only pill");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Dana Dark");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    const isDarkNow = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    const before = await isDarkNow();

    await pill.getByRole("button", { name: /Switch to (dark|light) mode/ }).click();
    await expect.poll(isDarkNow).toBe(!before);
  });

  test("desktop: Help opens a popover with the how-to and Esc closes", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only popover");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Hal Helper");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    await pill.getByRole("button", { name: "Help" }).click();

    const panel = page.getByRole("dialog", { name: "How to leave feedback" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Select any text");
    await expect(panel).toContainText("Type a comment");
    await expect(panel).toContainText("soft underline + a margin badge");
    await expect(panel).toContainText("The document owner sees your feedback instantly");
    await expect(panel).toContainText("No account needed");
    // The AI-agent-read-link section is owner-only — a reviewer must not see it.
    await expect(panel).not.toContainText("Hand an AI agent a read-only link");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("desktop: owner Help popover includes the AI agent read link section", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only popover");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olive Owner");

    const pill = page.getByRole("navigation", { name: "Document actions" });
    await pill.getByRole("button", { name: "Help" }).click();

    const panel = page.getByRole("dialog", { name: "How to leave feedback" });
    await expect(panel).toBeVisible();
    // Owner-only section explaining the ✨ "Copy AI agent read link" control.
    await expect(panel).toContainText("Hand an AI agent a read-only link");
    await expect(panel).toContainText("Copy AI agent read link");
    await expect(panel).toContainText("read-only access and cannot write");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("owner sees Download / Copy document / Copy reviewer link / Copy AI agent read link / Participants; reviewer does not", async ({ browser, page }) => {
    test.skip(!isDesktop(page), "owner pill actions are desktop pill controls");
    const doc = await createDocument(page);

    // Owner — all five owner-only controls present in the new structure.
    await redeemAndOpen(page, doc.ownerUrl, "Olive Owner");
    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    await expect(ownerPill.getByRole("link", { name: "Download Markdown" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy document (Markdown + comments)" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: /Participants/ })).toBeVisible();

    // Assert DOM order: Download → Copy document | sep | Copy reviewer link → Copy AI agent read link → Participants.
    const downloadBox = (await ownerPill.getByRole("link", { name: "Download Markdown" }).boundingBox())!;
    const copyDocBox = (await ownerPill.getByRole("button", { name: "Copy document (Markdown + comments)" }).boundingBox())!;
    const copyReviewerBox = (await ownerPill.getByRole("button", { name: "Copy reviewer link" }).boundingBox())!;
    const copyAgentBox = (await ownerPill.getByRole("button", { name: "Copy AI agent read link" }).boundingBox())!;
    const participantsBox = (await ownerPill.getByRole("button", { name: /Participants/ }).boundingBox())!;
    // Pill is vertical — y increases top to bottom.
    expect(downloadBox.y).toBeLessThan(copyDocBox.y);
    expect(copyDocBox.y).toBeLessThan(copyReviewerBox.y);
    expect(copyReviewerBox.y).toBeLessThan(copyAgentBox.y);
    expect(copyAgentBox.y).toBeLessThan(participantsBox.y);

    // Reviewer (separate context) does NOT see any owner-only controls.
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    try {
      await redeemAndOpen(rp, doc.inviteUrl, "Rhea Reviewer");
      const rPill = rp.getByRole("navigation", { name: "Document actions" });
      await expect(rPill).toBeVisible();
      await expect(rPill.getByRole("link", { name: "Download Markdown" })).toHaveCount(0);
      await expect(rPill.getByRole("button", { name: "Copy document (Markdown + comments)" })).toHaveCount(0);
      await expect(rPill.getByRole("button", { name: "Copy reviewer link" })).toHaveCount(0);
      await expect(rPill.getByRole("button", { name: "Copy AI agent read link" })).toHaveCount(0);
      await expect(rPill.getByRole("button", { name: /Participants/ })).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("desktop: 'Copy document' copies Markdown+comments to clipboard", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only clipboard test");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Owen Owner");

    // Shim clipboard.writeText to capture the copied value.
    await page.evaluate(() => {
      (window as unknown as { __copied: string }).__copied = "";
      navigator.clipboard.writeText = async (t: string) => {
        (window as unknown as { __copied: string }).__copied = t;
      };
    });

    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    await ownerPill.getByRole("button", { name: "Copy document (Markdown + comments)" }).click();

    // Wait for the async copy to complete.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
      .toContain("# Action Bar Spec Doc");

    // The copied text should be Markdown (starts with heading, not JSON or HTML).
    const copied = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
    expect(copied).toContain("# Action Bar Spec Doc");
    expect(copied).not.toContain("<html");
  });

  test("desktop: owner sees the Revoke reviewer link control; a reviewer does not", async ({
    browser,
    page,
  }) => {
    test.skip(!isDesktop(page), "owner revoke is a desktop pill control");
    const doc = await createDocument(page);

    // Owner — the destructive revoke control is present.
    await redeemAndOpen(page, doc.ownerUrl, "Owen Owner");
    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    await expect(
      ownerPill.getByRole("button", { name: "Revoke & regenerate reviewer link" }),
    ).toBeVisible();

    // Reviewer (separate context) does NOT see the revoke control.
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    try {
      await redeemAndOpen(rp, doc.inviteUrl, "Rhea Reviewer");
      const rPill = rp.getByRole("navigation", { name: "Document actions" });
      await expect(rPill).toBeVisible();
      await expect(
        rPill.getByRole("button", { name: "Revoke & regenerate reviewer link" }),
      ).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("desktop: revoke confirm runs revoke → regenerate → copy, and the old reviewer link stops redeeming", async ({
    browser,
    page,
  }) => {
    test.skip(!isDesktop(page), "desktop-only revoke control");
    const doc = await createDocument(page);
    // The reusable reviewer token minted at seed time — this is what revoke kills.
    const oldToken = doc.inviteUrl.split("#t=")[1] ?? "";
    expect(oldToken, "seed produced a reviewer token").toBeTruthy();

    await redeemAndOpen(page, doc.ownerUrl, "Rita Revoker");

    // Capture what gets written to the clipboard.
    await page.evaluate(() => {
      (window as unknown as { __copied: string }).__copied = "";
      navigator.clipboard.writeText = async (t: string) => {
        (window as unknown as { __copied: string }).__copied = t;
      };
    });

    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    await ownerPill
      .getByRole("button", { name: "Revoke & regenerate reviewer link" })
      .click();

    // Confirm-before-destroy popover with the spelled-out consequence.
    await expect(page.getByText("Revoke reviewer link?")).toBeVisible();
    await expect(
      page.getByText("Everyone using the current reviewer link loses access immediately"),
    ).toBeVisible();

    // Run the destructive action (exact:true so this doesn't also match the
    // trigger's longer "Revoke & regenerate reviewer link" accessible name).
    await page.getByRole("button", { name: "Revoke & regenerate", exact: true }).click();

    // A fresh reviewer link was minted and copied to the clipboard.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
      .toContain("/d/");
    const copied = await page.evaluate(
      () => (window as unknown as { __copied: string }).__copied,
    );
    const newToken = copied.split("#t=")[1] ?? "";
    expect(newToken, "a new reviewer token was generated").toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    // The OLD reviewer link is genuinely dead: a fresh visitor can no longer
    // redeem it (a neutral context avoids clobbering the owner page session).
    const ctx = await browser.newContext();
    try {
      const res = await ctx.request.post(`/api/d/${doc.slug}/redeem`, {
        data: { token: oldToken, name: "Late Reviewer" },
      });
      expect(res.status(), await res.text()).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  test("desktop: owner open-thread count badge hides at zero and reflects open threads", async ({
    page,
  }) => {
    test.skip(!isDesktop(page), "owner thread-count badge is a desktop pill control");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Tina Threads");

    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    // At zero open threads the badge is absent (no meaningless "0" chip).
    await expect(ownerPill.getByRole("status", { name: /open thread/ })).toHaveCount(0);

    // Seed one comment → exactly one open thread → the badge appears and reads it.
    await seedComment(page, doc.slug, ANCHOR_TEXT);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
    ).toBeVisible();

    await expect(ownerPill.getByRole("status", { name: "1 open thread" })).toBeVisible();
  });

  test("desktop: owner toolbar axe — no serious/critical violations", async ({ page }) => {
    test.skip(!isDesktop(page), "desktop-only axe check");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Axe Owner");

    // Wait for all five owner-only controls to settle before axe scan.
    const ownerPill = page.getByRole("navigation", { name: "Document actions" });
    await expect(ownerPill.getByRole("link", { name: "Download Markdown" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy document (Markdown + comments)" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
    await expect(ownerPill.getByRole("button", { name: /Participants/ })).toBeVisible();

    await expectNoSeriousA11yViolations(page, "owner ActionBar desktop pill (new structure)");
  });

  test("desktop: pill does not overlap a comment margin badge", async ({ page }) => {
    test.skip(!isDesktop(page), "gutter collision is a desktop concern");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Bea Badge");

    await seedComment(page, doc.slug, ANCHOR_TEXT);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
    ).toBeVisible();

    const badge = page.locator('button[aria-label*="comment thread"]').first();
    await expect(badge).toBeVisible({ timeout: 10_000 });

    const pill = page.getByRole("navigation", { name: "Document actions" });
    const pillBox = (await pill.boundingBox())!;
    const badgeBox = (await badge.boundingBox())!;

    const overlaps =
      pillBox.x < badgeBox.x + badgeBox.width &&
      pillBox.x + pillBox.width > badgeBox.x &&
      pillBox.y < badgeBox.y + badgeBox.height &&
      pillBox.y + pillBox.height > badgeBox.y;
    expect(overlaps, "pill must not overlap the comment badge").toBe(false);
    // The pill sits to the RIGHT of the badge.
    expect(pillBox.x).toBeGreaterThanOrEqual(badgeBox.x + badgeBox.width);
  });
});

test.describe("ActionBar — mobile FAB cluster", () => {
  test("mobile: desktop pill hidden; FAB ≥44px expands a labelled cluster; Help = sheet", async ({
    page,
  }) => {
    test.skip(isDesktop(page), "mobile-only cluster");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Mona Mobile");

    // The desktop pill nav is present in the DOM but hidden (md:flex).
    const pill = page.getByRole("navigation", { name: "Document actions" });
    await expect(pill).toBeHidden();

    // The FAB toggle is visible and a 44px+ touch target.
    const fab = page.getByRole("button", { name: "Document actions" });
    await expect(fab).toBeVisible();
    const fabBox = (await fab.boundingBox())!;
    expect(fabBox.width).toBeGreaterThanOrEqual(44);
    expect(fabBox.height).toBeGreaterThanOrEqual(44);
    await expect(fab).toHaveAttribute("aria-expanded", "false");

    // Expand → labelled items appear, each ≥44px.
    await fab.tap();
    await expect(fab).toHaveAttribute("aria-expanded", "true");

    const previewItem = page.getByRole("button", { name: "Preview" });
    await expect(previewItem).toBeVisible();
    const previewBox = (await previewItem.boundingBox())!;
    expect(previewBox.height).toBeGreaterThanOrEqual(44);
    const codeItem = page.getByRole("button", { name: "Code" });
    await expect(codeItem).toBeVisible();
    await expect(page.getByRole("button", { name: "Help" })).toBeVisible();

    // Preview↔Code is a segmented toggle (like desktop). Default view is Preview.
    await expect(previewItem).toHaveAttribute("aria-pressed", "true");
    await expect(codeItem).toHaveAttribute("aria-pressed", "false");
    // Tapping a segment switches the view AND collapses the overlay menu so the result
    // is immediately visible.
    await codeItem.tap();
    await expect(fab).toHaveAttribute("aria-expanded", "false");
    // Re-open: the toggle reflects the now-active Code view.
    await fab.tap();
    await expect(page.getByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // Groups are separated by spacing, NOT divider lines: there are no divider
    // elements, and the between-group gap is clearly larger than the within-group gap.
    await expect(page.locator("[data-mobile-divider]")).toHaveCount(0);
    const helpBox = (await page.getByRole("button", { name: "Help" }).boundingBox())!;
    const themeBox = (await page
      .getByRole("button", { name: /Switch to (dark|light) mode/ })
      .boundingBox())!;
    const toggleBox = (await page.getByRole("group", { name: "View" }).boundingBox())!;
    // Cluster order top→bottom: Help, Theme, (group gap), View toggle.
    const intraGap = themeBox.y - (helpBox.y + helpBox.height); // Help↔Theme (same group)
    const interGap = toggleBox.y - (themeBox.y + themeBox.height); // Theme↔toggle (across groups)
    expect(interGap).toBeGreaterThan(intraGap + 6);

    // Help opens a bottom-sheet dialog with the how-to.
    await page.getByRole("button", { name: "Help" }).tap();
    const sheet = page.getByRole("dialog", { name: "How to leave feedback" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Select any text");
    await expect(sheet).toContainText("No account needed");

    // Esc / close dismisses the sheet.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("mobile: owner reaches Download / Copy document / Copy reviewer link / Copy AI agent read link / Participants via the FAB cluster", async ({
    page,
  }) => {
    test.skip(isDesktop(page), "mobile-only cluster");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.ownerUrl, "Olive Owner");

    const fab = page.getByRole("button", { name: "Document actions" });
    await fab.tap();
    await expect(fab).toHaveAttribute("aria-expanded", "true");

    // The owner-only admin actions are all reachable in the expanded cluster (new structure).
    await expect(page.getByRole("link", { name: "Download Markdown" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy document (Markdown + comments)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy AI agent read link" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Participants/ })).toBeVisible();

    // And the copy-reviewer-link action actually works on mobile (mints + writes a link).
    await page.evaluate(() => {
      // @ts-expect-error test shim
      window.__copied = "";
      navigator.clipboard.writeText = async (t: string) => {
        // @ts-expect-error test shim
        window.__copied = t;
      };
    });
    await page.getByRole("button", { name: "Copy reviewer link" }).tap();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
      .toContain("/d/");
  });

  test("mobile: owner reaches Revoke link + open-thread count in the cluster; revoke copies a fresh link", async ({
    page,
  }) => {
    test.skip(isDesktop(page), "mobile-only cluster");
    const doc = await createDocument(page);
    const oldToken = doc.inviteUrl.split("#t=")[1] ?? "";
    await redeemAndOpen(page, doc.ownerUrl, "Morgan Mobile");

    // Seed one comment so the open-thread count status renders in the cluster.
    await seedComment(page, doc.slug, ANCHOR_TEXT);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
    ).toBeVisible();

    const fab = page.getByRole("button", { name: "Document actions" });
    await fab.tap();
    await expect(fab).toHaveAttribute("aria-expanded", "true");

    // m3: the open-thread count status is present and reflects the one open thread.
    await expect(page.getByRole("status", { name: "1 open thread" })).toBeVisible();

    // M5: capture the clipboard, open the Revoke confirm, and run it.
    await page.evaluate(() => {
      (window as unknown as { __copied: string }).__copied = "";
      navigator.clipboard.writeText = async (t: string) => {
        (window as unknown as { __copied: string }).__copied = t;
      };
    });
    await page
      .getByRole("button", { name: "Revoke & regenerate reviewer link" })
      .tap();
    await expect(page.getByText("Revoke reviewer link?")).toBeVisible();
    await page.getByRole("button", { name: "Revoke & regenerate", exact: true }).tap();

    // A fresh reviewer link (different token) was minted and copied.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string }).__copied))
      .toContain("/d/");
    const copied = await page.evaluate(
      () => (window as unknown as { __copied: string }).__copied,
    );
    const newToken = copied.split("#t=")[1] ?? "";
    expect(newToken, "a new reviewer token was generated").toBeTruthy();
    expect(newToken).not.toBe(oldToken);
  });

  test("mobile: cluster collapses and does not cover content at rest", async ({ page }) => {
    test.skip(isDesktop(page), "mobile-only cluster");
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Cara Collapse");

    // At rest only the FAB shows; the action items are not present.
    await expect(page.getByRole("button", { name: "Preview" })).toHaveCount(0);

    const fab = page.getByRole("button", { name: "Document actions" });
    await fab.tap();
    await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();

    // Tapping the FAB again (now an X) collapses.
    await fab.tap();
    await expect(page.getByRole("button", { name: "Preview" })).toHaveCount(0);

    // The document heading is visible (cluster never covers it at rest).
    await expect(
      page.getByRole("heading", { name: "Action Bar Spec Doc", level: 1 }),
    ).toBeVisible();
  });
});
