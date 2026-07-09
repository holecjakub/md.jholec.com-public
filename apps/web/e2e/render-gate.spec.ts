import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedDocument } from "./_helpers";

/**
 * End-to-end coverage for Plan 03 (render + gate). Creates a real document via
 * the public POST /api/documents endpoint, redeems the invite token through the
 * gate, then asserts the rendered preview and the raw-markdown code view. Runs
 * on both the desktop and mobile Playwright projects.
 */

const HEADING_TEXT = "Quarterly Report";
const SUBHEADING_TEXT = "Highlights";
const BOLD_TEXT = "very important";
const LIST_ITEM_TEXT = "First milestone";
const CODE_TOKEN = "greet";

const MARKDOWN_CONTENT = [
  `# ${HEADING_TEXT}`,
  "",
  `## ${SUBHEADING_TEXT}`,
  "",
  `This release is **${BOLD_TEXT}** for the team.`,
  "",
  "- " + LIST_ITEM_TEXT,
  "- Second milestone",
  "- Third milestone",
  "",
  "```ts",
  `function ${CODE_TOKEN}(name: string) {`,
  "  return `Hello, ${name}`;",
  "}",
  "```",
  "",
].join("\n");

interface CreateDocResult {
  slug: string;
  inviteToken: string;
}

/** Create a document via the gate-aware seed helper and extract slug + invite token. */
async function createDocument(page: Page): Promise<CreateDocResult> {
  const doc = await seedDocument(page.request, {
    title: "E2E Render Gate Doc",
    content: MARKDOWN_CONTENT,
    password: "test-password",
  });

  const hashIndex = doc.shareUrl.indexOf("#t=");
  expect(hashIndex, `shareUrl missing #t= token: ${doc.shareUrl}`).toBeGreaterThan(-1);
  const inviteToken = doc.shareUrl.slice(hashIndex + "#t=".length);
  expect(inviteToken.length).toBeGreaterThan(0);

  return { slug: doc.slug, inviteToken };
}

/** Assert no serious/critical axe violations, with a readable failure message. */
async function expectNoSeriousA11yViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  const summary = serious
    .map((v) => `${v.id} (${v.impact}): ${v.help}`)
    .join("\n");
  expect(serious, `Serious/critical a11y violations on ${context}:\n${summary}`).toEqual(
    [],
  );
}

test("gate redeem -> render preview -> code view, a11y clean on both", async ({
  page,
}) => {
  const { slug, inviteToken } = await createDocument(page);

  // 1. Navigate to the document with the invite token in the URL fragment.
  await page.goto(`/d/${slug}#t=${inviteToken}`);

  // 2. The gate appears (no session yet). Assert it and check accessibility.
  const heading = page.getByRole("heading", { name: "Welcome" });
  await expect(heading).toBeVisible();

  // The fragment must be scrubbed from the URL on mount.
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  await expectNoSeriousA11yViolations(page, "gate");

  // 3. Fill the name field and submit. With a token present, only name is shown.
  await page.getByLabel("Name").fill("Test Reviewer");
  await page.getByRole("button", { name: "View document" }).click();

  // 4. The rendered preview shows the document heading text.
  const renderedHeading = page.getByRole("heading", { name: HEADING_TEXT, level: 1 });
  await expect(renderedHeading).toBeVisible();
  await expect(page.getByRole("heading", { name: SUBHEADING_TEXT, level: 2 })).toBeVisible();
  await expect(page.getByText(BOLD_TEXT)).toBeVisible();
  await expect(page.getByText(LIST_ITEM_TEXT)).toBeVisible();

  // Top-level blocks carry stable data-block-id attributes (anchoring prep).
  await expect(page.locator("[data-block-id]").first()).toBeVisible();

  await expectNoSeriousA11yViolations(page, "rendered preview");

  // 5. Toggle to the code view via the floating ActionBar and assert the raw
  // markdown source is shown. On desktop the view toggle lives in the right-edge
  // pill; on mobile it is behind the bottom-right FAB, which must be opened first.
  const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
  if (!isDesktop) {
    await page.getByRole("button", { name: "Document actions" }).tap();
  }
  await page.getByRole("button", { name: "Code" }).click();

  // Picking a view collapses the mobile cluster; wait for it to fully retract so
  // the a11y scan below doesn't catch the labelled pills mid-exit-animation.
  if (!isDesktop) {
    await expect(page.getByRole("button", { name: "Code" })).toHaveCount(0);
  }

  // Both panels stay mounted across toggles (the preview is hidden, not
  // destroyed, so switching back never re-parses the markdown) — scope to the
  // VISIBLE pre: the hidden preview keeps its own <pre> for the ```ts fence.
  // During the ~200ms crossfade the outgoing preview intentionally keeps
  // visibility:visible, so "pre:visible" briefly matches BOTH panels' <pre>;
  // poll the count down to 1 (retrying) before the strict single-element
  // assertions below, or they die on a strict-mode violation mid-fade.
  const codeBlock = page.locator("pre:visible");
  await expect(codeBlock).toHaveCount(1);
  await expect(codeBlock).toBeVisible();
  // Raw markdown markers should be visible verbatim in the code view.
  await expect(codeBlock).toContainText(`# ${HEADING_TEXT}`);
  await expect(codeBlock).toContainText("```ts");
  await expect(codeBlock).toContainText(`function ${CODE_TOKEN}`);

  // The Preview→Code swap fades the panel in (opacity+blur). Wait until it has
  // fully settled (no ancestor still at <1 opacity) so axe samples the resting
  // contrast, not a mid-fade frame.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const visiblePre = Array.from(document.querySelectorAll("pre")).find(
          (p) => getComputedStyle(p).visibility !== "hidden",
        );
        let el: HTMLElement | null = visiblePre ?? null;
        if (!el) return false;
        while (el) {
          if (parseFloat(getComputedStyle(el).opacity) < 1) return false;
          el = el.parentElement;
        }
        return true;
      }),
    )
    .toBe(true);

  await expectNoSeriousA11yViolations(page, "code view");
});
