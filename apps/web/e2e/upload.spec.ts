/**
 * E2E happy-path + flow-branch coverage for the upload module.
 *
 * Covers: §3 (full flow desktop+mobile), §3.2 (fragment shape/no-secret),
 * §3.3 (reviewer link opens real doc), §3.4 (gate branches), §3.5 (file
 * validation), §3.6 (retention/ExpiryHint), §3.7 (reset/remove focus),
 * §3.8 (self-host card), §4 (reduced-motion).
 *
 * Runs on both `desktop` and `mobile` Playwright projects.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  EARLY_ACCESS_PASSWORD,
  VALID_MARKDOWN,
  mdFile,
  txtFile,
  oversizedMdFile,
  emptyMdFile,
  resetRateLimits,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDesktop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 640;
}

/** Navigate to "/" and wait for the page to finish loading. */
async function gotoHome(page: Page): Promise<void> {
  await page.goto("/");
  // Wait for the hero h1 — proves the page rendered.
  await expect(page.getByRole("heading", { name: "Markdown, shared for feedback.", level: 1 })).toBeVisible();
}

/** Unlock the gate via the UI (Locked → Unlock → Dropzone idle).
 * Resets the rate-limit bucket before submitting, and retries once on 429
 * (rate-limited) so parallel runs don't race on the shared loopback IP. */
async function unlockViaUI(page: Page): Promise<void> {
  // Import resetRateLimits dynamically here so the helper stays import-free.
  // We call it via the request context that the page uses.
  await resetRateLimits();

  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");

  // If the UI shows a 429 alert, reset and retry once.
  const browseBtn = page.getByRole("button", { name: "Browse files" });
  const isVisible = await browseBtn.isVisible().catch(() => false);
  if (!isVisible) {
    const alert = page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /Too many|rate|429/i });
    const hasAlert = await alert.isVisible().catch(() => false);
    if (hasAlert) {
      await resetRateLimits();
      await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
      await page.keyboard.press("Enter");
    }
  }

  await expect(browseBtn).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// §3.1 Full happy-path flow
// ---------------------------------------------------------------------------

test("full upload flow: locked → unlock → select → confirm → success", async ({ page, context }) => {
  await gotoHome(page);

  // §3.1.1: Locked state visible without unlocking.
  // The section h2 "Upload a Markdown file" is sr-only on the landing (layout revision 2026-06-15).
  // Only the "Upload a file" CTA button is visible; no "Testers only" pill on the landing.
  await expect(page.getByRole("button", { name: "Upload a file" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prefer to host it yourself?", level: 2 })).toBeVisible();
  // Hero micro-line "Documents open at /d/<slug>" is present.
  await expect(page.getByText(/Documents open at/)).toBeVisible();
  // "Testers only" pill is NOT visible on the landing (only appears in the Unlock card).
  await expect(page.locator("span").filter({ hasText: /^Testers only$/ })).toHaveCount(0);

  // §3.1.2: Activate Locked CTA → Unlock state.
  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
  // Pill appears in the Unlock card (not on the landing).
  await expect(page.locator("span").filter({ hasText: /^Testers only$/ }).first()).toBeVisible();
  // Focus is on the access-password field.
  await expect(page.getByLabel("Access password")).toBeFocused();

  // §3.1.3: Submit correct password → Dropzone idle.
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  const browseBtn = page.getByRole("button", { name: "Browse files" });
  await expect(browseBtn).toBeVisible({ timeout: 10_000 });
  await expect(browseBtn).toBeFocused();
  // Polite region says "Upload unlocked."
  await expect.poll(() => page.evaluate(() => {
    const polite = document.querySelector<HTMLElement>("[aria-live='polite']");
    return polite?.textContent ?? "";
  })).toContain("Upload unlocked.");

  // §3.1.4: Select file via Browse picker.
  const chooser = page.waitForEvent("filechooser");
  await browseBtn.click();
  const fc = await chooser;
  await fc.setFiles(mdFile("notes.md", VALID_MARKDOWN));

  // §3.1.4 assertion: Selected state.
  // File chip shows "notes.md" (exact match on the span, not the sr-only polite region).
  await expect(page.locator("span", { hasText: /^notes\.md$/ }).first()).toBeVisible({ timeout: 5_000 });
  // Title field is focused and pre-filled "notes".
  const titleField = page.getByLabel("Title");
  await expect(titleField).toBeVisible();
  await expect(titleField).toBeFocused();
  const titleValue = await titleField.inputValue();
  expect(titleValue).toBe("notes");
  // Polite region announced "<filename> selected."
  await expect.poll(() => page.evaluate(() => {
    const polite = document.querySelector<HTMLElement>("[aria-live='polite']");
    return polite?.textContent ?? "";
  })).toContain("notes.md selected.");
  // Password field present.
  await expect(page.locator('input[autocomplete="new-password"]')).toBeVisible();

  // §3.1.5: Show/hide toggle.
  const toggle = page.getByRole("button", { name: "Show password" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  // After clicking: input type = text, aria-pressed = true, name = "Hide password".
  const passwordInput = page.locator('input[autocomplete="new-password"]');
  await expect(passwordInput).toHaveAttribute("type", "text");
  const toggleHide = page.getByRole("button", { name: "Hide password" });
  await expect(toggleHide).toHaveAttribute("aria-pressed", "true");
  await toggleHide.click();
  // Reverts.
  await expect(passwordInput).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-pressed", "false");

  // §3.1.6: Fill password and submit.
  await page.locator('input[autocomplete="new-password"]').fill("test-password");
  await page.keyboard.press("Enter");

  // §3.1.7: Success state.
  const successH2 = page.getByRole("heading", { name: "Your document is live.", level: 2 });
  await expect(successH2).toBeVisible({ timeout: 15_000 });
  // Success h2 is focused.
  await expect(successH2).toBeFocused();

  // Polite region does NOT contain the old redundant message.
  const politeText = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[aria-live='polite']");
    return el?.textContent ?? "";
  });
  expect(politeText).not.toContain("Your share link is ready.");

  // Reviewer link block — FIRST in DOM order (layout revision 2026-06-15: reviewer-first).
  const reviewerInput = page.getByRole("textbox", { name: "Reviewer link URL" });
  await expect(reviewerInput).toBeVisible();
  const copyReviewerBtn = page.getByRole("button", { name: "Copy reviewer link" });
  await expect(copyReviewerBtn).toBeVisible();

  // Owner link block — SECOND in DOM order.
  const ownerInput = page.getByRole("textbox", { name: "Owner link URL" });
  await expect(ownerInput).toBeVisible();
  const copyOwnerBtn = page.getByRole("button", { name: "Copy owner link" });
  await expect(copyOwnerBtn).toBeVisible();

  // AI agent link block — THIRD in DOM order, with read-only tag and violet Sparkles icon.
  const agentInput = page.getByRole("textbox", { name: "AI agent link URL" });
  await expect(agentInput).toBeVisible();
  const copyAgentBtn = page.getByRole("button", { name: "Copy AI agent link" });
  await expect(copyAgentBtn).toBeVisible();

  // DOM order: reviewer → owner → agent (top to bottom in bounding boxes).
  const reviewerBB = await reviewerInput.boundingBox();
  const ownerBB = await ownerInput.boundingBox();
  const agentBB = await agentInput.boundingBox();
  expect(reviewerBB!.y).toBeLessThan(ownerBB!.y);
  expect(ownerBB!.y).toBeLessThan(agentBB!.y);

  // How-it-works present.
  await expect(page.getByRole("heading", { name: "How it works", level: 2 })).toBeVisible();

  // CLI note present, text-only (no <a> link).
  await expect(page.getByText("Your agent can upload for you.")).toBeVisible();
  const cliLinks = await page.locator("text=Your agent can upload for you.").locator("..").locator("a").count();
  expect(cliLinks).toBe(0);

  // §3.1.8: Copy assertions (desktop only for clipboard; mobile gets field-select fallback).
  const ownerUrl = await ownerInput.inputValue();
  const shareUrl = await reviewerInput.inputValue();
  const agentUrl = await agentInput.inputValue();
  expect(ownerUrl.length).toBeGreaterThan(0);
  expect(shareUrl.length).toBeGreaterThan(0);
  expect(agentUrl.length).toBeGreaterThan(0);

  if (isDesktop(page)) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await copyOwnerBtn.click();
    await expect(copyOwnerBtn).toHaveText("Copied", { timeout: 3_000 });
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[aria-live='polite']");
      return el?.textContent ?? "";
    })).toContain("Owner link copied");
    const clipOwner = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipOwner).toBe(ownerUrl);

    await copyReviewerBtn.click();
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[aria-live='polite']");
      return el?.textContent ?? "";
    })).toContain("Reviewer link copied");
    const clipReviewer = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipReviewer).toBe(shareUrl);
  }

  // §3.2: Fragment shape + no-secret-in-query.
  expect(ownerUrl).toMatch(/\/d\/[^#?]+#o=[^#?&]+$/);
  expect(shareUrl).toMatch(/\/d\/[^#?]+#t=[^#?&]+$/);
  // Agent URL: GET capability URL — token in PATH (/d/<slug>/agent/<token>), no fragment.
  expect(agentUrl).toMatch(/\/d\/[^/]+\/agent\/pat_[^/?#]+$/);
  expect(new URL(ownerUrl).search).toBe("");
  expect(new URL(shareUrl).search).toBe("");
  // Agent URL has no query string and no fragment — token is in the path only.
  expect(new URL(agentUrl).search).toBe("");
  expect(new URL(agentUrl).hash).toBe("");
  // Password not in URLs.
  expect(ownerUrl).not.toContain(EARLY_ACCESS_PASSWORD);
  expect(shareUrl).not.toContain(EARLY_ACCESS_PASSWORD);
  expect(agentUrl).not.toContain(EARLY_ACCESS_PASSWORD);

  // §3.3: Reviewer link opens working document.
  await page.goto(shareUrl);
  const welcomeH = page.getByRole("heading", { name: "Welcome", level: 1 });
  await expect(welcomeH).toBeVisible();
  // Token scrubbed from URL.
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await page.getByLabel("Name").fill("Test Reviewer");
  await page.getByRole("button", { name: "View document" }).click();
  // Rendered doc heading (from VALID_MARKDOWN h1 "Quarterly Report").
  await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// §3.4 Gate branches
// ---------------------------------------------------------------------------

test("wrong early-access password shows error, stays in Unlock, no doc created", async ({ browser }) => {
  // Use fresh context so no unlock cookie is inherited.
  const freshCtx = await browser.newContext();
  const freshPage = await freshCtx.newPage();
  try {
    await freshPage.goto("/");
    await freshPage.getByRole("button", { name: "Upload a file" }).click();
    await expect(freshPage.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
    await freshPage.getByLabel("Access password").fill("wrong-pass");
    await freshPage.keyboard.press("Enter");

    // Still in Unlock state.
    await expect(freshPage.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible({ timeout: 5_000 });
    // Inline alert with correct copy.
    await expect(freshPage.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toContainText("That password is not right. Check it and try again.");
    // Field is cleared and re-focused.
    const field = freshPage.getByLabel("Access password");
    await expect.poll(() => field.inputValue()).toBe("");
    await expect(field).toBeFocused();

    // No document created: a direct API call from a cookieless context should still 403.
    // Use the browser's playwright.request (no cookies) rather than page.request (has cookies).
    const probe = await freshCtx.request.post("/api/documents", {
      data: { title: "Probe", content: "# x", password: "test-password" },
    });
    expect(probe.status()).toBe(403);
  } finally {
    await freshCtx.close();
  }
});

test("rate-limited 429 on gate shows correct copy (mocked — does not poison shared IP)", async ({ page }) => {
  await page.goto("/");
  // Mock the early-access endpoint to return 429.
  await page.route("**/api/early-access", (route) => {
    void route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "Too many attempts" }),
    });
  });

  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByLabel("Access password")).toBeVisible();
  await page.getByLabel("Access password").fill("anything");
  await page.keyboard.press("Enter");

  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toContainText("Too many attempts. Please wait a moment and try again.", { timeout: 5_000 });
});

test("locked state: no Dropzone reachable without going through Unlock", async ({ page }) => {
  await page.goto("/");
  // The "Upload a file" CTA is visible; the section h2 is sr-only on the landing.
  await expect(page.getByRole("button", { name: "Upload a file" })).toBeVisible();
  // No Browse button without unlocking.
  await expect(page.getByRole("button", { name: "Browse files" })).toHaveCount(0);
  // No dropzone.
  await expect(page.locator('[data-testid="dropzone"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// §3.5 File validation
// ---------------------------------------------------------------------------

test("wrong file type shows error; valid file after error clears it", async ({ page }) => {
  await gotoHome(page);
  await unlockViaUI(page);

  // Wrong type.
  const chooser1 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser1).setFiles(txtFile("report.txt"));
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toContainText("That's not a Markdown file. Drop a .md file to continue.", { timeout: 5_000 });

  // Valid file clears error and advances to Selected.
  const chooser2 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser2).setFiles(mdFile("notes.md", VALID_MARKDOWN));
  await expect(page.locator("span", { hasText: /^notes\.md$/ }).first()).toBeVisible({ timeout: 5_000 });
  // Error gone.
  await expect(page.getByRole("alert", { name: /not a Markdown/i })).toHaveCount(0);
});

test("oversized file shows error", async ({ page }) => {
  await gotoHome(page);
  await unlockViaUI(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(oversizedMdFile());
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toContainText("That file is too large. Markdown files up to 2 MB are supported.", { timeout: 5_000 });
});

test("empty file shows error", async ({ page }) => {
  await gotoHome(page);
  await unlockViaUI(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(emptyMdFile());
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toContainText("That file looks empty. Pick a Markdown file with some content.", { timeout: 5_000 });
});

test.describe("drag/drop (desktop only)", () => {
  test("drag-over swaps label to 'Drop to upload', drop advances to Selected", async ({ page }) => {
    test.skip(!isDesktop(page), "drag/drop is a desktop-only enhancement");
    await gotoHome(page);
    await unlockViaUI(page);

    // Simulate dragenter on the dropzone container.
    // dispatchEvent init is passed as eventInit, so use page.evaluate for full DragEvent control.
    const dropzone = page.locator(".rounded-3xl").first();
    await expect(dropzone).toBeVisible();

    // Trigger dragenter via evaluate so we have control over the DataTransfer object.
    await page.evaluate(() => {
      const el = document.querySelector(".rounded-3xl");
      if (!el) throw new Error("Dropzone not found");
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    // Label swaps to "Drop to upload".
    await expect(page.getByText("Drop to upload")).toBeVisible({ timeout: 3_000 });

    // Drop a valid file via evaluate — attach a real File to the DataTransfer.
    await page.evaluate(() => {
      const el = document.querySelector(".rounded-3xl");
      if (!el) throw new Error("Dropzone not found");
      const dt = new DataTransfer();
      const file = new File(["# Hello\n\nworld"], "hello.md", { type: "text/markdown" });
      dt.items.add(file);
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    // Advances to Selected.
    await expect(page.locator("span", { hasText: /^hello\.md$/ }).first()).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// §3.6 Retention surfacing
// ---------------------------------------------------------------------------

test("ExpiryHint shows absolute auto-delete date derived from API expiresAt", async ({ page }) => {
  // This test does a real create; reset the shared-loopback-IP upload bucket first so
  // it isn't 429'd by cumulative uploads earlier in the full serial suite run.
  await resetRateLimits();
  await gotoHome(page);
  await unlockViaUI(page);

  // Intercept the POST /api/documents response to capture expiresAt.
  let capturedExpiresAt = "";
  await page.route("**/api/documents", async (route) => {
    const res = await route.fetch();
    const body = await res.json() as { slug: string; shareUrl: string; ownerUrl: string; agentUrl: string; expiresAt: string; };
    capturedExpiresAt = body.expiresAt ?? "";
    await route.fulfill({ response: res });
  });

  // Complete the upload.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
  await page.locator('input[autocomplete="new-password"]').fill("test-password");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

  // Compute expected date label.
  expect(capturedExpiresAt.length).toBeGreaterThan(0);
  const expectedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(capturedExpiresAt));

  // Assert ExpiryHint contains the date.
  await expect(page.getByText(new RegExp(`Auto-deletes on ${expectedDate}`))).toBeVisible({ timeout: 5_000 });
  // The 30-day sentence.
  await expect(page.getByText(/Hosted for 30 days on jholec\.com/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// §3.7 Reset / Remove focus
// ---------------------------------------------------------------------------

test("'Upload another file' returns to Dropzone idle with Browse focused, gate stays unlocked", async ({ page }) => {
  await gotoHome(page);
  await unlockViaUI(page);

  // Complete upload.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
  await page.locator('input[autocomplete="new-password"]').fill("test-password");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

  // Click "Upload another file".
  await page.getByRole("button", { name: "Upload another file" }).click();

  // Back to Dropzone idle — gate stays unlocked (no Unlock re-prompt).
  const browseBtn = page.getByRole("button", { name: "Browse files" });
  await expect(browseBtn).toBeVisible({ timeout: 5_000 });
  // The Locked CTA "Upload a file" is gone — we're in the dropzone, not back to locked.
  await expect(page.getByRole("button", { name: "Upload a file" })).toHaveCount(0);
  // The Unlock "Early access" heading is not present either.
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toHaveCount(0);
  // Focus lands on Browse.
  await expect(browseBtn).toBeFocused();
});

test("'Remove file' from Selected returns to Dropzone idle with Browse focused", async ({ page }) => {
  await gotoHome(page);
  await unlockViaUI(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
  await expect(page.locator("span", { hasText: /^notes\.md$/ }).first()).toBeVisible({ timeout: 5_000 });

  // Find and click the Remove button.
  const removeBtn = page.getByRole("button", { name: /Remove/i }).first();
  await expect(removeBtn).toBeVisible();
  await removeBtn.click();

  // Back to idle.
  const browseBtn = page.getByRole("button", { name: "Browse files" });
  await expect(browseBtn).toBeVisible({ timeout: 5_000 });
  await expect(browseBtn).toBeFocused();
});

// ---------------------------------------------------------------------------
// §3.8 Self-host card
// ---------------------------------------------------------------------------

test("self-host card GitHubButton has correct href, target, rel, and accessible name", async ({ page }) => {
  await gotoHome(page);

  const ghBtn = page.getByRole("link", { name: "View md.jholec.com on GitHub (opens in a new tab)" });
  await expect(ghBtn).toBeVisible();
  await expect(ghBtn).toHaveAttribute("href", "https://github.com/holecjakub/md.jholec.com-public");
  await expect(ghBtn).toHaveAttribute("target", "_blank");
  const rel = await ghBtn.getAttribute("rel");
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
});

// ---------------------------------------------------------------------------
// §4 Reduced motion
// ---------------------------------------------------------------------------

test("reduced-motion: success DOM order, focus, and announcements are correct", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoHome(page);
  await unlockViaUI(page);

  // Polite "Upload unlocked." fires (state-driven, not animation-driven).
  await expect.poll(() => page.evaluate(() => {
    const polite = document.querySelector<HTMLElement>("[aria-live='polite']");
    return polite?.textContent ?? "";
  })).toContain("Upload unlocked.");

  // Select file.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
  await expect(page.locator("span", { hasText: /^notes\.md$/ }).first()).toBeVisible({ timeout: 5_000 });

  // "notes.md selected." announced.
  await expect.poll(() => page.evaluate(() => {
    const polite = document.querySelector<HTMLElement>("[aria-live='polite']");
    return polite?.textContent ?? "";
  })).toContain("notes.md selected.");

  // Complete upload.
  await page.locator('input[autocomplete="new-password"]').fill("test-password");
  await page.keyboard.press("Enter");
  const successH2 = page.getByRole("heading", { name: "Your document is live.", level: 2 });
  await expect(successH2).toBeVisible({ timeout: 15_000 });

  // Focus moves to h2 (state-driven, not animation-onComplete-driven).
  await expect(successH2).toBeFocused();

  // DOM order: reviewer → owner → agent (LinkReveal renders in this order).
  const reviewerBB2 = await page.getByRole("textbox", { name: "Reviewer link URL" }).boundingBox();
  const ownerBB2 = await page.getByRole("textbox", { name: "Owner link URL" }).boundingBox();
  const agentBB2 = await page.getByRole("textbox", { name: "AI agent link URL" }).boundingBox();
  expect(reviewerBB2!.y).toBeLessThan(ownerBB2!.y);
  expect(ownerBB2!.y).toBeLessThan(agentBB2!.y);
});
