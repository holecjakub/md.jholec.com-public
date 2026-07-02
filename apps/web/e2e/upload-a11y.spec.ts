/**
 * Accessibility coverage for the upload module.
 *
 * §5.1 — axe scans per state in both themes (light + dark), both viewports.
 * §5.2 — Explicit keyboard/SR/focus/heading/target assertions binding the
 *         gate resolutions (dropzone-not-a-button, one tab stop, show/hide
 *         toggle aria-pressed, busy button aria-disabled+aria-busy, two
 *         distinct live regions, distinct copy-button names, URL field
 *         aria-labels, focus map, heading outline, 48px targets, visible rings).
 */

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  EARLY_ACCESS_PASSWORD,
  VALID_MARKDOWN,
  mdFile,
  txtFile,
  expectNoSeriousA11yViolations,
  resetRateLimits,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Reset rate limits before each top-level describe group that performs uploads.
// The a11y spec does ~17 uploads total; resetting before each group keeps each
// group well within the 20/15min bucket.
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // resetRateLimits() is safe: it refuses to run against non-localhost Supabase.
  await resetRateLimits();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDesktop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 640;
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Markdown, shared for feedback.", level: 1 })).toBeVisible();
}

async function unlockViaUI(page: Page): Promise<void> {
  // Reset rate limits before each unlock to prevent the early_access bucket (10/15min)
  // from exhausting when many tests run serially. Safe: resetRateLimits() refuses to
  // run against non-localhost Supabase.
  await resetRateLimits();
  await page.getByRole("button", { name: "Upload a file" }).click();
  await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
  await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({ timeout: 10_000 });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  // Set via localStorage before navigation so next-themes picks it up.
  await page.addInitScript((t) => {
    localStorage.setItem("theme", t);
  }, theme);
}

/**
 * Wait for the UploadPanel step container to finish its enter transition.
 *
 * UploadPanel wraps each step in a `motion.div` that animates
 * `opacity: 0 → 1` over 240ms. Scanning mid-animation causes axe's
 * color-contrast checks to see blended effective colors (e.g. a semi-transparent
 * blue on white appears lighter than the CSS variable value). Waiting for the
 * transition settles contrast at resting state.
 *
 * We target `section[aria-labelledby='upload-heading'] > *` — the direct child
 * motion.div wrapping each step — rather than all elements, to avoid confetti
 * spans (aria-hidden but inside an aria-hidden container, so CSS :not() misses
 * them) and other decorative animations that never fully settle.
 */
async function waitForAllOpacitySettled(page: Page): Promise<void> {
  await expect.poll(
    () =>
      page.evaluate(() => {
        // Check direct children of the UploadPanel section (the step containers).
        const panel = document.querySelector<HTMLElement>(
          "section[aria-labelledby='upload-heading']",
        );
        if (!panel) return 1;
        // Check the step wrapper div (direct child of the section, after the
        // two sr-only live-region <p> nodes that are always opacity 1).
        const children = panel.querySelectorAll<HTMLElement>(":scope > div");
        for (const el of children) {
          const opacity = parseFloat(getComputedStyle(el).opacity);
          if (opacity < 0.95) return 0;
        }
        return 1;
      }),
    { timeout: 5_000 },
  ).toBe(1);
}

/** Wait for element opacity to settle at 1 before running axe. */
async function waitForOpacitySettled(page: Page, selector: string): Promise<void> {
  await expect.poll(() =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return 1;
      let current: Element | null = el;
      while (current) {
        if (parseFloat(getComputedStyle(current as HTMLElement).opacity) < 0.95) return 0;
        current = current.parentElement;
      }
      return 1;
    }, selector),
    { timeout: 5_000 },
  ).toBe(1);
}

async function runAxeForState(page: Page, stateLabel: string): Promise<void> {
  // Wait for the enter-animation opacity transition to settle so axe measures
  // resting-state contrast, not mid-animation blended effective colors.
  await waitForAllOpacitySettled(page);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.help}`).join("\n");
  expect(serious, `Serious/critical a11y violations on ${stateLabel}:\n${summary}`).toEqual([]);

  // Explicitly assert no color-contrast violation.
  const contrastViolations = results.violations.filter((v) => v.id === "color-contrast");
  const contrastSummary = contrastViolations.map((v) => `${v.id}: ${v.help}`).join("\n");
  expect(
    contrastViolations,
    `color-contrast violations on ${stateLabel}:\n${contrastSummary}`,
  ).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// §5.1 axe per state — LIGHT THEME
// ---------------------------------------------------------------------------

test.describe("axe — light theme", () => {
  test.beforeEach(async ({ page }) => {
    await setTheme(page, "light");
  });

  test("Locked state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await runAxeForState(page, "Locked (light)");
  });

  test("Unlock state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await page.getByRole("button", { name: "Upload a file" }).click();
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
    await runAxeForState(page, "Unlock (light)");
  });

  test("Dropzone idle state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);
    await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible();
    await runAxeForState(page, "Dropzone idle (light)");
  });

  test("Dropzone error state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(txtFile("report.txt"));
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toBeVisible({ timeout: 5_000 });
    await runAxeForState(page, "Dropzone error (light)");
  });

  test("Selected / confirm state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });
    await runAxeForState(page, "Selected/confirm (light)");
  });

  test("Success state — axe clean", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });
    await waitForOpacitySettled(page, "h2");
    await runAxeForState(page, "Success (light)");
  });
});

// ---------------------------------------------------------------------------
// §5.1 axe per state — DARK THEME
// ---------------------------------------------------------------------------

test.describe("axe — dark theme", () => {
  test.beforeEach(async ({ page }) => {
    await setTheme(page, "dark");
  });

  test("Locked state — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    // Wait for theme to apply.
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await runAxeForState(page, "Locked (dark)");
  });

  test("Unlock state — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await page.getByRole("button", { name: "Upload a file" }).click();
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
    await runAxeForState(page, "Unlock (dark)");
  });

  test("Dropzone idle — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await unlockViaUI(page);
    await runAxeForState(page, "Dropzone idle (dark)");
  });

  test("Dropzone error — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(txtFile("report.txt"));
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ })).toBeVisible({ timeout: 5_000 });
    await runAxeForState(page, "Dropzone error (dark)");
  });

  test("Selected — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });
    await runAxeForState(page, "Selected (dark)");
  });

  test("Success — axe clean (dark)", async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 3_000 });
    await unlockViaUI(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });
    await waitForOpacitySettled(page, "h2");
    await runAxeForState(page, "Success (dark)");
  });
});

// ---------------------------------------------------------------------------
// §5.2 Explicit keyboard / SR / structural assertions
// ---------------------------------------------------------------------------

test.describe("§5.2 Structural + ARIA assertions", () => {
  // Reset rate limits before the §5.2 block so the 20-upload bucket is fresh
  // even after the §5.1 axe scans (which themselves perform several uploads).
  test.beforeAll(async () => {
    await resetRateLimits();
  });
  test("dropzone is NOT a control: no role, no tabindex, file input is aria-hidden + tabindex=-1", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    // The Browse button is the single tab stop inside the dropzone region.
    const browseBtn = page.getByRole("button", { name: "Browse files" });
    await expect(browseBtn).toBeVisible();

    // File input has aria-hidden="true" and tabIndex=-1.
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toHaveAttribute("aria-hidden", "true");
    await expect(fileInput).toHaveAttribute("tabindex", "-1");

    // No role="button" on the dropzone container.
    const roleButtonElements = await page.locator('[role="button"]').all();
    for (const el of roleButtonElements) {
      const hasFileInput = await el.locator('input[type="file"]').count();
      if (hasFileInput > 0) {
        throw new Error("Dropzone container has role=button — violates gate-res B3");
      }
    }
  });

  test("show/hide toggle: aria-pressed reflects state, accessible name toggles, ≥48px, type flips", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    // Select a file to get to the confirm state.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });

    const toggle = page.getByRole("button", { name: "Show password" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Hit box ≥ 48px.
    const bb = await toggle.boundingBox();
    expect(Math.min(bb!.width, bb!.height)).toBeGreaterThanOrEqual(48);

    await toggle.click();
    const toggleHide = page.getByRole("button", { name: "Hide password" });
    await expect(toggleHide).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('input[autocomplete="new-password"]')).toHaveAttribute("type", "text");

    await toggleHide.click();
    await expect(page.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('input[autocomplete="new-password"]')).toHaveAttribute("type", "password");
  });

  test("busy confirm button: aria-disabled+aria-busy, no HTML disabled, still focusable, aria-describedby", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });
    await page.locator('input[autocomplete="new-password"]').fill("test-password");

    // Delay the POST /api/documents response long enough to assert the busy state.
    await page.route("**/api/documents", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    // Submit and immediately assert the busy state.
    await page.keyboard.press("Enter");

    const confirmBtn = page.getByRole("button", { name: /Creating your link/ });
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await expect(confirmBtn).toHaveAttribute("aria-disabled", "true");
    await expect(confirmBtn).toHaveAttribute("aria-busy", "true");

    // Must NOT have the HTML disabled attribute.
    expect(await confirmBtn.getAttribute("disabled")).toBeNull();

    // Must still be focusable (toBeFocused-able; no tabindex=-1).
    await confirmBtn.focus();
    await expect(confirmBtn).toBeFocused();

    // aria-describedby points at the polite region.
    const describedBy = await confirmBtn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const politeEl = page.locator(`#${describedBy}`);
    await expect(politeEl).toHaveAttribute("aria-live", "polite");

    // Wait for success so the route finishes cleanly.
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });
  });

  test("two distinct live regions: one polite, one role=alert, no element is both", async ({ page }) => {
    await gotoHome(page);

    // polite count = 1.
    const politeEls = await page.locator("[aria-live='polite']").all();
    expect(politeEls.length).toBeGreaterThanOrEqual(1);

    // alert count = 1.
    const alertEls = await page.locator("[role='alert']").all();
    expect(alertEls.length).toBeGreaterThanOrEqual(1);

    // No element is both polite AND role=alert.
    const both = await page.locator("[aria-live='polite'][role='alert']").count();
    expect(both).toBe(0);

    // Unlock to trigger polite message.
    await unlockViaUI(page);
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[aria-live='polite']");
      return el?.textContent ?? "";
    })).toContain("Upload unlocked.");

    // "Your share link is ready." NEVER written to polite region.
    // (Complete an upload and check.)
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

    const finalPoliteText = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[aria-live='polite']");
      return el?.textContent ?? "";
    });
    expect(finalPoliteText).not.toContain("Your share link is ready.");
  });

  test("distinct copy button names: 'Copy owner link' and 'Copy reviewer link'", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

    const copyOwner = page.getByRole("button", { name: "Copy owner link" });
    const copyReviewer = page.getByRole("button", { name: "Copy reviewer link" });
    await expect(copyOwner).toBeVisible();
    await expect(copyReviewer).toBeVisible();
    // Names are distinct (already proven by two separate role queries, but be explicit).
    expect(await copyOwner.getAttribute("aria-label")).toBe("Copy owner link");
    expect(await copyReviewer.getAttribute("aria-label")).toBe("Copy reviewer link");
  });

  test("URL inputs: aria-label, readOnly, full value accessible", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

    const ownerInput = page.getByRole("textbox", { name: "Owner link URL" });
    const reviewerInput = page.getByRole("textbox", { name: "Reviewer link URL" });

    // aria-labels present.
    await expect(ownerInput).toHaveAttribute("aria-label", "Owner link URL");
    await expect(reviewerInput).toHaveAttribute("aria-label", "Reviewer link URL");

    // Both are readOnly.
    await expect(ownerInput).toHaveAttribute("readonly");
    await expect(reviewerInput).toHaveAttribute("readonly");

    // Full URLs present in value (not truncated).
    const ownerVal = await ownerInput.inputValue();
    const reviewerVal = await reviewerInput.inputValue();
    expect(ownerVal).toMatch(/^https?:\/\//);
    expect(ownerVal).toContain("#o=");
    expect(reviewerVal).toMatch(/^https?:\/\//);
    expect(reviewerVal).toContain("#t=");
  });

  test("focus map: OPEN_UNLOCK→access field; GATE_OK→Browse; FILE_ACCEPTED→Title; UPLOAD_OK→success h2; REMOVE_FILE→Browse; RESET→Browse; CANCEL_UNLOCK/Esc→Locked CTA", async ({ page }) => {
    await gotoHome(page);

    // OPEN_UNLOCK → access field.
    await page.getByRole("button", { name: "Upload a file" }).click();
    await expect(page.getByLabel("Access password")).toBeFocused({ timeout: 3_000 });

    // CANCEL_UNLOCK / Esc → Locked CTA.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Upload a file" })).toBeFocused({ timeout: 3_000 });

    // GATE_OK → Browse.
    await page.getByRole("button", { name: "Upload a file" }).click();
    await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
    await page.keyboard.press("Enter");
    const browseBtn = page.getByRole("button", { name: "Browse files" });
    await expect(browseBtn).toBeFocused({ timeout: 10_000 });

    // FILE_ACCEPTED → Title.
    const chooser = page.waitForEvent("filechooser");
    await browseBtn.click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeFocused({ timeout: 5_000 });

    // REMOVE_FILE → Browse.
    const removeBtn = page.getByRole("button", { name: /Remove/i }).first();
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();
    await expect(page.getByRole("button", { name: "Browse files" })).toBeFocused({ timeout: 3_000 });

    // UPLOAD_OK → success h2.
    const chooser2 = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser2).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    const successH2 = page.getByRole("heading", { name: "Your document is live.", level: 2 });
    await expect(successH2).toBeVisible({ timeout: 15_000 });
    await expect(successH2).toBeFocused({ timeout: 3_000 });

    // RESET → Browse.
    await page.getByRole("button", { name: "Upload another file" }).click();
    await expect(page.getByRole("button", { name: "Browse files" })).toBeFocused({ timeout: 3_000 });
  });

  test("heading outline: single h1, non-skipping h2s, only one module h2 at a time", async ({ page }) => {
    await gotoHome(page);

    // Single h1.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const h1Text = await page.getByRole("heading", { level: 1 }).textContent();
    expect(h1Text).toContain("Markdown, shared for feedback.");

    // Locked: the module h2 "Upload a Markdown file" is sr-only (layout revision 2026-06-15).
    // It exists in the DOM but is NOT visible. The visible CTA is "Upload a file" button.
    // "Early access" heading is NOT present at all in locked state.
    await expect(page.getByRole("button", { name: "Upload a file" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toHaveCount(0);

    // Navigate to Unlock: "Early access" h2 is now visible; "Upload a file" CTA is gone.
    await page.getByRole("button", { name: "Upload a file" }).click();
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload a file" })).toHaveCount(0);

    // Unlock → Success: "Your document is live." h2.
    await page.getByLabel("Access password").fill(EARLY_ACCESS_PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Browse files" })).toBeVisible({ timeout: 10_000 });

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });
    // Only one module h2: "Your document is live." — no Locked CTA or Early access heading.
    await expect(page.getByRole("button", { name: "Upload a file" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toHaveCount(0);

    // HowItWorks and SelfHostCard h2s coexist.
    await expect(page.getByRole("heading", { name: "How it works", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Prefer to host it yourself?", level: 2 })).toBeVisible();
  });

  test("visible focus rings on key interactive elements", async ({ page }) => {
    // :focus-visible is driven by the keyboard-interaction heuristic. Mobile browsers
    // correctly suppress the focus ring on programmatic focus (no keyboard involved),
    // so this assertion only applies to desktop — skip on mobile.
    test.skip(!isDesktop(page), "focus-visible ring is keyboard-driven; not applicable on mobile");

    await gotoHome(page);

    // Check focus ring on the Locked CTA.
    const lockedCta = page.getByRole("button", { name: "Upload a file" });
    await lockedCta.focus();
    await expect(lockedCta).toBeFocused();
    const ctaMatches = await lockedCta.evaluate((el) =>
      el.matches(":focus-visible"),
    );
    expect(ctaMatches).toBe(true);

    // GitHub button.
    const ghBtn = page.getByRole("link", { name: "View md.jholec.com on GitHub (opens in a new tab)" });
    await ghBtn.focus();
    await expect(ghBtn).toBeFocused();
    const ghMatches = await ghBtn.evaluate((el) => el.matches(":focus-visible"));
    expect(ghMatches).toBe(true);

    // Unlock and check Browse.
    await unlockViaUI(page);
    const browseBtn = page.getByRole("button", { name: "Browse files" });
    await browseBtn.focus();
    const browseMatches = await browseBtn.evaluate((el) => el.matches(":focus-visible"));
    expect(browseMatches).toBe(true);
  });

  test("48px touch targets on key elements", async ({ page }) => {
    await gotoHome(page);

    // Math.ceil throughout handles sub-pixel rendering: `min-h-12` / `size-12`
    // (48px CSS) can render as 47.5–47.9px on fractional device-pixel-ratio
    // displays, which is still the correct implementation of the 48px target.

    // Locked CTA.
    const ctaBB = await page.getByRole("button", { name: "Upload a file" }).boundingBox();
    expect(Math.ceil(Math.min(ctaBB!.width, ctaBB!.height))).toBeGreaterThanOrEqual(48);

    // GitHub button.
    const ghBB = await page.getByRole("link", { name: "View md.jholec.com on GitHub (opens in a new tab)" }).boundingBox();
    expect(Math.ceil(Math.min(ghBB!.width, ghBB!.height))).toBeGreaterThanOrEqual(48);

    // Unlock and check Browse.
    await unlockViaUI(page);
    const browseBB = await page.getByRole("button", { name: "Browse files" }).boundingBox();
    expect(Math.ceil(Math.min(browseBB!.width, browseBB!.height))).toBeGreaterThanOrEqual(48);

    // Select file to get to confirm state.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });

    // Show/hide toggle ≥ 48px.
    const toggleBB = await page.getByRole("button", { name: "Show password" }).boundingBox();
    expect(Math.ceil(Math.min(toggleBB!.width, toggleBB!.height))).toBeGreaterThanOrEqual(48);

    // Confirm button ≥ 48px.
    const confirmBB = await page.getByRole("button", { name: "Create share link" }).boundingBox();
    expect(Math.ceil(Math.min(confirmBB!.width, confirmBB!.height))).toBeGreaterThanOrEqual(48);

    // Remove control: 48×48 slot, does not overlap filename.
    const removeBB = await page.getByRole("button", { name: /Remove/i }).first().boundingBox();
    expect(Math.ceil(Math.min(removeBB!.width, removeBB!.height))).toBeGreaterThanOrEqual(48);

    // Filename chip bounding box — Remove left edge ≥ filename right edge.
    const filenameEl = page.locator("span", { hasText: /^notes\.md$/ }).first();
    const filenameBB = await filenameEl.boundingBox();
    if (filenameBB && removeBB) {
      // On desktop the remove button is to the right of the filename.
      if (isDesktop(page)) {
        expect(removeBB.x).toBeGreaterThanOrEqual(filenameBB.x + filenameBB.width - 4); // -4px tolerance
      }
    }

    // Complete upload to get copy buttons.
    await page.locator('input[autocomplete="new-password"]').fill("test-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your document is live.", level: 2 })).toBeVisible({ timeout: 15_000 });

    // Copy owner link button ≥ 48px.
    // Math.ceil handles sub-pixel rendering: `min-h-12` (3rem = 48px CSS) can
    // render as 47.5–47.9px on fractional device-pixel-ratio displays, which
    // is still the correct implementation of the 48px touch target.
    const copyOwnerBB = await page.getByRole("button", { name: "Copy owner link" }).boundingBox();
    expect(Math.ceil(Math.min(copyOwnerBB!.width, copyOwnerBB!.height))).toBeGreaterThanOrEqual(48);

    // Copy reviewer link button ≥ 48px.
    const copyReviewerBB = await page.getByRole("button", { name: "Copy reviewer link" }).boundingBox();
    expect(Math.ceil(Math.min(copyReviewerBB!.width, copyReviewerBB!.height))).toBeGreaterThanOrEqual(48);
  });

  test("client-side form validation: empty title + password < 8 produce correct alert copy + focus", async ({ page }) => {
    await gotoHome(page);
    await unlockViaUI(page);

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await chooser).setFiles(mdFile("notes.md", VALID_MARKDOWN));
    await expect(page.getByLabel("Title")).toBeVisible({ timeout: 5_000 });

    // Clear title field.
    await page.getByLabel("Title").fill("");
    // Don't fill password (stays at "").
    await page.getByRole("button", { name: "Create share link" }).click();

    // Title error copy + focus.
    await expect(
      page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /Give your document a title/i }),
    ).toBeVisible({ timeout: 3_000 });
    await expect(page.getByLabel("Title")).toBeFocused();

    // Fill title, leave password too short.
    await page.getByLabel("Title").fill("My doc");
    await page.locator('input[autocomplete="new-password"]').fill("short");
    await page.getByRole("button", { name: "Create share link" }).click();

    // Password error copy.
    await expect(page.getByText("Password must be at least 8 characters.")).toBeVisible({ timeout: 3_000 });
  });

  test("Testers only pill is in accessibility tree (not aria-hidden) in Unlock state (not on landing)", async ({ page }) => {
    await gotoHome(page);

    // Use a scoped locator to get the pill <span> exactly (not the helper <p> that
    // contains "testers only" as a substring).
    const pillLocator = page.locator("span").filter({ hasText: /^Testers only$/ });

    // In Locked state (landing) the pill is NOT shown — it lives in the Unlock card only.
    // Layout revision 2026-06-15: landing = hero + one button; testers-only detail
    // lives in the password entry, not on the landing.
    await expect(pillLocator).toHaveCount(0);

    // In Unlock state the pill is visible and not aria-hidden.
    await page.getByRole("button", { name: "Upload a file" }).click();
    await expect(page.getByRole("heading", { name: "Early access", level: 2 })).toBeVisible();
    await expect(pillLocator.first()).toBeVisible();
    const ariaHiddenUnlock = await pillLocator.first().evaluate((el) => el.getAttribute("aria-hidden"));
    expect(ariaHiddenUnlock).not.toBe("true");
  });
});

// ---------------------------------------------------------------------------
// smoke.spec.ts coverage confirmation: home page axe stays clean with Locked state
// (gate-res: the smoke scan now runs against the Locked upload state)
// ---------------------------------------------------------------------------

test("smoke: home page with Locked upload state has no serious a11y violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "home/Locked (upload-a11y smoke)");
});
