import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedDocument } from "./_helpers";

/**
 * End-to-end coverage for the Medium/Docs-style hybrid commenting UI:
 * inline underline locators on anchored text, per-block testimonial badges in
 * the right margin (avatar stack + reaction summary), hover coupling
 * (badge ↔ underline), click-to-open-thread-at-the-text, and the owner toolbar /
 * realtime / resolve flows.
 *
 * Each test creates a real document via POST /api/documents, redeems through the
 * gate as a reviewer/owner, selects text in the preview, posts a comment via the
 * inline composer, then asserts: a per-block badge appears with an avatar stack
 * and (after a reaction) a reaction summary; hovering the badge colors in the
 * inline underline; clicking opens the thread popover WITHOUT a quoted-text
 * block (the underline conveys the quote); reply + react work; owner-only
 * Resolve is present for owners and absent for reviewers. Axe runs on the
 * composer and thread popover. Runs on both desktop and mobile projects.
 */

const QUOTE_TEXT = "Highlights of the quarter";

// Two distinct sentences inside ONE paragraph (same block): each is anchored by a
// separate comment, so the block carries two threads — used to assert that each
// sentence's underline opens ONLY its own thread (no badge fan-out).
const SENTENCE_A = "Revenue grew twelve percent this period.";
const SENTENCE_B = "Churn fell to a record low of two percent.";
const TWO_SENTENCE_PARAGRAPH = `${SENTENCE_A} ${SENTENCE_B}`;

const MARKDOWN_CONTENT = [
  "# Quarterly Report",
  "",
  "## Summary",
  "",
  `${QUOTE_TEXT} are summarized in this opening paragraph for review.`,
  "",
  TWO_SENTENCE_PARAGRAPH,
  "",
  "- First milestone shipped",
  "- Second milestone in progress",
  "",
].join("\n");

interface CreatedDoc {
  slug: string;
  inviteUrl: string; // /d/{slug}#t={token}
  ownerUrl: string; // /d/{slug}#o={token}
}

/** Create a document via the gate-aware seed helper and return its slug + share/owner URLs. */
async function createDocument(page: Page): Promise<CreatedDoc> {
  const doc = await seedDocument(page.request, {
    title: "E2E Commenting Doc",
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

/** Redeem an invite/owner URL through the gate and wait for the rendered doc. */
async function redeemAndOpen(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);

  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "View document" }).click();

  await expect(
    page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
  ).toBeVisible();
}

/**
 * Seed a comment on `sentence` directly via the API — deterministic, avoiding the
 * selection→composer UI path (which saturates under parallel load). Requires the
 * doc to be open (so [data-block-id] blocks exist) and a redeemed session cookie
 * (page.request shares the context cookies). Caller reloads to render the result.
 */
async function seedComment(
  page: Page,
  slug: string,
  sentence: string,
  body: string,
): Promise<void> {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, sentence);
  if (!blockId) throw new Error(`seedComment: no [data-block-id] block contains "${sentence}"`);
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: sentence, prefix: "", suffix: "", blockId }, body },
  });
  expect(res.status(), await res.text()).toBe(201);
}

/**
 * Select `text` inside the preview by walking the DOM for a text node that
 * contains it, then dispatch a pointerup on the [data-block-id] container so the
 * CommentsLayer's selection listener fires and floats the composer.
 */
async function selectTextInPreview(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const container = document.querySelector(".md-prose");
    if (!container) return false;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text;
      if (candidate.textContent && candidate.textContent.includes(needle)) {
        node = candidate;
        break;
      }
    }
    if (!node || !node.textContent) return false;

    const start = node.textContent.indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + needle.length);

    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);

    const blockEl =
      (node.parentElement?.closest("[data-block-id]") as HTMLElement | null) ??
      (container as HTMLElement);
    const rect = range.getBoundingClientRect();
    blockEl.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
    return true;
  }, text);
}

/** The inline selection composer (floats above the selection). */
function selectionComposer(page: Page) {
  return page.getByRole("dialog", { name: "Add a comment on the selected text" });
}

/** The expanded thread popover (opened from a badge or underline). */
function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

/** A per-block testimonial badge in the right margin. */
function anyBadge(page: Page) {
  return page.locator('button[aria-label*="comment thread"]');
}

/** The inline underline span(s) on the anchored text. */
function anyHighlight(page: Page) {
  return page.locator("span.md-comment-highlight");
}

/**
 * Wait until a popup has fully settled before axe samples it.
 *
 * Two independent in-flight effects make axe read blended (and therefore
 * spuriously low-contrast) colours:
 *
 *  1. Enter opacity. The popup animates in via a motion wrapper (AnimatePresence /
 *     Framer Motion writes opacity inline each frame). While the popup, any
 *     ancestor, or any inner wrapper is below full opacity its subtree composites
 *     with the light page behind it.
 *  2. Avatar background-color transition. The avatar fallback starts on the light
 *     `bg-muted` token, then its dark identity colour is applied inline and CSS
 *     transitions it over ~150ms. Mid-transition the background is an intermediate
 *     tan — so white initials momentarily look like white-on-tan even at opacity 1.
 *
 * So gate on BOTH: every element in the chain (self + ancestors + descendants) at
 * opacity ≥ 0.99, AND no CSS transition/animation still running in the subtree
 * (getAnimations catches CSS transitions; the opacity poll covers Framer's rAF).
 */
async function waitForPopupSettled(page: Page, selector: string) {
  await expect
    .poll(
      () =>
        page.evaluate((sel) => {
          const root = document.querySelector<HTMLElement>(sel);
          if (!root) return false;
          const chain: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
          for (let a = root.parentElement; a; a = a.parentElement) chain.push(a);
          const allOpaque = chain.every((el) => Number(getComputedStyle(el).opacity) >= 0.99);
          const animationsDone = root
            .getAnimations({ subtree: true })
            .every((a) => a.playState === "finished" || a.playState === "idle");
          return allOpaque && animationsDone;
        }, selector),
      {
        message: `popup ${selector} never settled (opacity + transitions)`,
        timeout: 5000,
      },
    )
    .toBe(true);
}

/** Assert no serious/critical axe violations within an element. */
async function expectNoSeriousA11y(page: Page, selector: string, context: string) {
  await waitForPopupSettled(page, selector);
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.help}`).join("\n");
  expect(serious, `Serious/critical a11y violations on ${context}:\n${summary}`).toEqual([]);
}

/**
 * Select `quote` in the preview, post a text comment on it, and wait for at least
 * one block badge + inline underline to be present. `expectedHighlights` lets a
 * caller (e.g. the fan-out test) assert the running highlight count so the second
 * comment's underline is confirmed before interacting.
 */
async function postCommentOnText(
  page: Page,
  quote: string,
  body: string,
  expectedHighlights = 1,
): Promise<void> {
  const composer = selectionComposer(page);
  // Selection → composer is timing-sensitive (a synthetic pointerup feeds a
  // setTimeout(evaluate) that can lose the range under heavy parallel load). Poll
  // BOTH the selection AND the composer surfacing so a dropped selection re-fires
  // rather than failing the whole test on a one-off miss.
  await expect
    .poll(
      async () => {
        if (await composer.isVisible()) return true;
        await selectTextInPreview(page, quote);
        return composer.isVisible();
      },
      { message: `could not surface the composer for "${quote}"`, timeout: 10_000 },
    )
    .toBe(true);

  // Fill + submit, resiliently: the composer can close if the selection is lost
  // between surfacing and typing (a selectionchange under heavy parallel load).
  // Re-surface and retry the fill rather than failing on a transient close. We
  // run the a11y gate AFTER a stable fill so the popup is settled (a filled
  // composer won't auto-close) and axe samples a steady DOM.
  const textarea = composer.getByRole("textbox", { name: "Add a comment…" });
  await expect
    .poll(
      async () => {
        if (!(await composer.isVisible())) {
          await selectTextInPreview(page, quote);
          return false;
        }
        try {
          await textarea.fill(body, { timeout: 2000 });
          return (await textarea.inputValue()) === body;
        } catch {
          return false;
        }
      },
      { message: `could not fill the composer for "${quote}"`, timeout: 15_000 },
    )
    .toBe(true);

  await expectNoSeriousA11y(
    page,
    '[aria-label="Add a comment on the selected text"]',
    "selection composer",
  );

  // Submit resiliently up to the moment the highlight count grows. Each iteration
  // either (re)submits an OPEN composer, or — if the composer closed before we
  // could click WITHOUT the comment landing — re-surfaces + re-fills it. We stop
  // the instant the new highlight appears, so a successful submit never triggers a
  // duplicate re-fill (the count guard short-circuits before re-selecting).
  const submit = composer.getByRole("button", { name: "Comment" });
  await expect
    .poll(
      async () => {
        if ((await anyHighlight(page).count()) >= expectedHighlights) return true;
        if (await submit.isVisible()) {
          await submit.click({ timeout: 2000 }).catch(() => {});
        } else if (await textarea.isVisible()) {
          await textarea.fill(body, { timeout: 2000 }).catch(() => {});
        } else {
          await selectTextInPreview(page, quote);
        }
        return (await anyHighlight(page).count()) >= expectedHighlights;
      },
      { message: `comment on "${quote}" never produced a highlight`, timeout: 15_000 },
    )
    .toBe(true);

  await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });
  await expect(anyHighlight(page)).toHaveCount(expectedHighlights, { timeout: 10_000 });
}

/**
 * Open the selection composer, post a text comment, and wait for the block badge
 * (and inline underline) to appear.
 */
async function postCommentViaComposer(page: Page, body: string): Promise<void> {
  await postCommentOnText(page, QUOTE_TEXT, body, 1);
}

/** True if the highlight span for `text` carries data-emphasized. */
function highlightEmphasized(page: Page, text: string) {
  return page.evaluate((needle) => {
    const spans = Array.from(
      document.querySelectorAll<HTMLElement>("span.md-comment-highlight"),
    );
    const span = spans.find((s) => (s.textContent ?? "").includes(needle));
    return span?.getAttribute("data-emphasized") === "true";
  }, text);
}

/** Which of the two known sentences is currently emphasised ("A" | "B" | null). */
async function whichSentenceEmphasized(page: Page): Promise<"A" | "B" | null> {
  const a = await highlightEmphasized(page, SENTENCE_A);
  const b = await highlightEmphasized(page, SENTENCE_B);
  if (a && !b) return "A";
  if (b && !a) return "B";
  return null;
}

test.describe("Commenting — inline highlights + per-block badges", () => {
  test("reviewer: select → comment → badge + underline → thread → reply + reaction", async ({
    page,
  }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Rita Reviewer");

    // 1. Post a comment; a per-block badge and an inline underline appear.
    await postCommentViaComposer(page, "This sentence needs a citation.");

    // The badge carries an avatar stack (the commenter) — its accessible label
    // names the participant, and its rendered content shows the RR initials.
    const badge = anyBadge(page).first();
    await expect(badge).toHaveAttribute("aria-label", /Rita Reviewer/);
    await expect(badge).toContainText("RR");

    // The underline wraps exactly the anchored quote.
    await expect(anyHighlight(page).first()).toHaveText(QUOTE_TEXT);

    // 2. Hover coupling: hovering the badge emphasises the inline underline.
    // Re-hover inside the poll: under load a just-posted comment can still be
    // reconciling (optimistic → server row), and a pointer that drifted off the
    // badge between renders would drop the hover. Re-asserting the hover each tick
    // makes the coupling check robust without weakening it.
    await expect
      .poll(
        async () => {
          await badge.hover();
          return page.evaluate(() => {
            const el = document.querySelector("span.md-comment-highlight");
            return el?.getAttribute("data-emphasized");
          });
        },
        { message: "hovering the badge did not emphasise the underline", timeout: 5000 },
      )
      .toBe("true");

    // 3. Click the badge → thread popover opens, anchored at the text.
    await badge.click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();

    // The root comment body + author are shown — but the quoted source text is NOT
    // duplicated in the dialog (the inline underline conveys it).
    await expect(thread).toContainText("This sentence needs a citation.");
    await expect(thread).toContainText("Rita Reviewer");
    await expect(thread).not.toContainText(QUOTE_TEXT);

    // 4. Reviewer must NOT see a Resolve control.
    await expect(thread.getByRole("button", { name: /resolve/i })).toHaveCount(0);

    // 5. Post a reply. On mobile the reply field is hidden behind a Reply button
    //    (compact UI), so reveal it first; on desktop it is already visible.
    const replyBox = thread.getByRole("textbox", { name: "Reply…" });
    if (!(await replyBox.isVisible())) {
      await thread.getByRole("button", { name: "Reply" }).click();
    }
    await expect(replyBox).toBeVisible();
    await replyBox.click();
    await replyBox.fill("Agreed, will add a source.");
    await thread.getByRole("button", { name: "Reply" }).click();
    await expect(thread).toContainText("Agreed, will add a source.");

    // 6. React on the unified reaction bar: one tap toggles the reaction ON with
    //    no separate confirm step. The 👍 grows from a round add-button into a
    //    pressed pill carrying its count (1).
    await thread.getByRole("button", { name: "React: Looks good" }).click();
    const reactedPill = thread
      .locator('button[aria-pressed="true"]')
      .filter({ hasText: "1" })
      .first();
    await expect(reactedPill).toBeVisible({ timeout: 10_000 });
    // Its accessible name flips to the remove affordance (tap-again = un-react).
    await expect(
      thread.getByRole("button", { name: "Remove your Looks good reaction" }),
    ).toBeVisible();

    // The badge now shows the 👍 total (1) in the margin.
    await expect(anyBadge(page).first()).toContainText("1");

    // 6b. Tapping the same emoji again toggles the reaction OFF — the pill drops
    //     its count and reverts to an unpressed add-button (no leftover state).
    await thread.getByRole("button", { name: "Remove your Looks good reaction" }).click();
    await expect(
      thread.locator('button[aria-pressed="true"]').filter({ hasText: "1" }),
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(
      thread.getByRole("button", { name: "React: Looks good" }),
    ).toHaveAttribute("aria-pressed", "false");

    // 7. a11y check on the open thread popover.
    await expectNoSeriousA11y(page, '[aria-label="Comment thread"]', "thread popover");
  });

  test("multi-thread block: each underline opens ONLY its own thread; badge opens the overview", async ({
    page,
  }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Una Underline");

    // Seed TWO comments on TWO different sentences of the SAME paragraph via the
    // API (deterministic; the composer UI path flakes under parallel load — it's
    // covered by its own test). Reload so the per-sentence underlines render.
    await seedComment(page, doc.slug, SENTENCE_A, "Source for the revenue figure?");
    await seedComment(page, doc.slug, SENTENCE_B, "Great churn improvement.");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
    ).toBeVisible();
    await expect(page.locator("span.md-comment-highlight").first()).toBeVisible({
      timeout: 10_000,
    });
    // Two sentences → two distinct underline spans on the one paragraph.
    await expect(anyHighlight(page)).toHaveCount(2, { timeout: 10_000 });

    // ONE quiet block badge for the paragraph. It does NOT fan out: there is no
    // menu/disclosure, and it never exposes aria-haspopup="menu".
    const badge = page.locator('button[aria-label*="comment threads"]').first();
    await expect(badge).toBeVisible();
    await expect(badge).not.toHaveAttribute("aria-haspopup", "menu");

    const isTouch = await page.evaluate(
      () => window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    );

    // Hovering the badge (desktop) must NOT spawn a role=menu fan-out.
    if (!isTouch) {
      await badge.hover();
      await expect(page.getByRole("menu")).toHaveCount(0);
    }

    const bodyFor: Record<"A" | "B", string> = {
      A: "Source for the revenue figure?",
      B: "Great churn improvement.",
    };

    // Locate each sentence's underline span by its text.
    const underlineFor = (sentence: "A" | "B") =>
      anyHighlight(page).filter({ hasText: sentence === "A" ? SENTENCE_A : SENTENCE_B });

    // For EACH sentence: hovering its underline emphasises ONLY that sentence
    // (thread-precise), and clicking it opens ONLY that sentence's thread — the
    // sibling's body must NOT appear, and the popover is single-thread ("Thread").
    for (const sentence of ["A", "B"] as const) {
      // After opening and closing a thread, React may re-render the highlight layer,
      // unmounting and remounting the underline spans. Wait for the highlight count
      // to stabilize (both underlines back) before interacting with them.
      await expect(anyHighlight(page)).toHaveCount(2, { timeout: 5_000 });

      if (!isTouch) {
        // Move mouse to a neutral position (top-left of the viewport) before
        // hovering the next sentence to ensure the mouseover event fires cleanly.
        await page.mouse.move(0, 0);
        // Wait for any residual emphasis to clear (no sentence emphasized).
        await expect.poll(() => whichSentenceEmphasized(page), { timeout: 3000 }).toBeNull();

        // Re-hover inside the poll: the highlight layer can re-render between the
        // hover and the emphasis read (unmounting the span the mouseover landed on),
        // so a single hover is racy. Re-hovering each iteration makes it deterministic.
        await expect
          .poll(
            async () => {
              await underlineFor(sentence).first().hover();
              return whichSentenceEmphasized(page);
            },
            {
              message: `hovering sentence ${sentence} did not emphasise exactly itself`,
              timeout: 8000,
            },
          )
          .toBe(sentence);
      }

      // Click the underline and wait for the thread popover to appear.
      await underlineFor(sentence).first().click();
      const thread = threadPopover(page);
      await expect(thread).toBeVisible({ timeout: 8_000 });
      await expect(thread).toContainText(bodyFor[sentence]);
      await expect(thread).not.toContainText(bodyFor[sentence === "A" ? "B" : "A"]);
      await expect(thread.getByRole("heading", { name: "Thread" })).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(thread).toBeHidden({ timeout: 5_000 });
      // Move mouse away from the underline so no residual hover state bleeds into
      // the next iteration's emphasis poll.
      if (!isTouch) {
        await page.mouse.move(0, 0);
      }
    }

    // Clicking the BADGE opens the block OVERVIEW: both threads in one popover.
    await badge.click();
    const overview = threadPopover(page);
    await expect(overview).toBeVisible();
    await expect(overview.getByRole("heading", { name: "2 threads" })).toBeVisible();
    await expect(overview).toContainText(bodyFor.A);
    await expect(overview).toContainText(bodyFor.B);
  });

  test("inline underline is keyboard operable: focus + Enter opens that thread", async ({
    page,
  }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) < 640,
      "keyboard activation is a desktop/fine-pointer affordance",
    );

    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Kay Keyboard");

    await postCommentOnText(page, SENTENCE_A, "Keyboard thread A.", 1);
    await postCommentOnText(page, SENTENCE_B, "Keyboard thread B.", 2);

    // The underline span is a real role=button with tabindex; focusing it lights
    // its own sentence and Enter opens ONLY that thread.
    const underlineB = anyHighlight(page).filter({ hasText: SENTENCE_B }).first();
    await underlineB.focus();
    await expect
      .poll(() => highlightEmphasized(page, SENTENCE_B), {
        message: "focusing underline B did not light sentence B",
        timeout: 5000,
      })
      .toBe(true);

    await page.keyboard.press("Enter");
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Keyboard thread B.");
    await expect(thread).not.toContainText("Keyboard thread A.");
    await expect(thread.getByRole("heading", { name: "Thread" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();
  });

  test("clicking the inline underline opens the thread at the text", async ({ page }) => {
    const doc = await createDocument(page);
    await redeemAndOpen(page, doc.inviteUrl, "Holly Highlighter");

    await postCommentViaComposer(page, "Underline click opens this.");

    // Click the underlined text itself (not the badge).
    await anyHighlight(page).first().click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Underline click opens this.");
    await expect(thread).not.toContainText(QUOTE_TEXT);
  });

  test("realtime: a second reviewer sees a new badge/underline live", async ({
    browser,
    page,
  }) => {
    const doc = await createDocument(page);

    await redeemAndOpen(page, doc.inviteUrl, "Alice Author");

    const ctxB: BrowserContext = await browser.newContext();
    const pageB = await ctxB.newPage();
    try {
      await redeemAndOpen(pageB, doc.inviteUrl, "Bob Bystander");
      await expect(anyBadge(pageB)).toHaveCount(0);

      await postCommentViaComposer(page, "Live update test comment.");

      let realtimeOk = true;
      try {
        await expect(anyBadge(pageB).first()).toBeVisible({ timeout: 15_000 });
      } catch {
        realtimeOk = false;
      }

      if (!realtimeOk) {
        await pageB.reload();
        await expect(
          pageB.getByRole("heading", { name: "Quarterly Report", level: 1 }),
        ).toBeVisible();
        await expect(anyBadge(pageB).first()).toBeVisible({ timeout: 10_000 });

        throw new Error(
          "REALTIME NOTED FAILURE: second context did not receive the new " +
            "comment via broadcast within 15s; it only appeared after a reload. " +
            "The badge/comment data is correct, but the realtime broadcast path is " +
            "not delivering live updates in this environment.",
        );
      }

      await anyBadge(pageB).first().click();
      await expect(threadPopover(pageB)).toContainText("Live update test comment.");
    } finally {
      await ctxB.close();
    }
  });

  test("realtime: a second reviewer sees a DELETE live via the delta path (no full-list GET)", async ({
    browser,
    page,
  }) => {
    const doc = await createDocument(page);

    // Owner seeds a comment BEFORE the second context opens, so the setup does
    // not depend on broadcast delivery — only the delete propagation does.
    await redeemAndOpen(page, doc.ownerUrl, "Alice Author");
    await seedComment(page, doc.slug, SENTENCE_A, "Comment to be deleted live.");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
    ).toBeVisible();
    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });

    const ctxB: BrowserContext = await browser.newContext();
    const pageB = await ctxB.newPage();
    try {
      await redeemAndOpen(pageB, doc.inviteUrl, "Bob Bystander");
      await expect(anyBadge(pageB).first()).toBeVisible({ timeout: 10_000 });
      await expect(anyHighlight(pageB).first()).toBeVisible({ timeout: 10_000 });

      // Owner opens the thread and walks the trash → confirm flow.
      await anyBadge(page).first().click();
      const thread = threadPopover(page);
      await expect(thread).toContainText("Comment to be deleted live.");
      await thread.getByRole("button", { name: /Delete comment by/ }).click();

      // The delete signal must merge as a DELTA on other clients: a verify-GET
      // of the ONE comment (404 → drop), never a full-list refetch. Count list
      // GETs from here on (the single-comment GET has a longer pathname and the
      // SUBSCRIBED-join refetch already happened when pageB opened above).
      const listGets: string[] = [];
      pageB.on("request", (req) => {
        if (req.method() !== "GET") return;
        if (new URL(req.url()).pathname === `/api/d/${doc.slug}/comments`) {
          listGets.push(req.url());
        }
      });

      await thread.getByRole("button", { name: "Delete", exact: true }).click();

      let realtimeOk = true;
      try {
        await expect(anyBadge(pageB)).toHaveCount(0, { timeout: 15_000 });
      } catch {
        realtimeOk = false;
      }

      if (!realtimeOk) {
        await pageB.reload();
        await expect(
          pageB.getByRole("heading", { name: "Quarterly Report", level: 1 }),
        ).toBeVisible();
        await expect(anyBadge(pageB)).toHaveCount(0, { timeout: 10_000 });

        throw new Error(
          "REALTIME NOTED FAILURE: second context did not drop the deleted " +
            "comment via broadcast within 15s; it only disappeared after a " +
            "reload. The delete/verify data is correct, but the realtime " +
            "broadcast path is not delivering live updates in this environment.",
        );
      }

      // Underline goes with the badge, and the delta path never fell back to a
      // full-list refetch on the second client.
      await expect(anyHighlight(pageB)).toHaveCount(0);
      expect(listGets, "delete must propagate as a delta, not a full-list GET").toEqual([]);
    } finally {
      await ctxB.close();
    }
  });

  test("realtime: a second reviewer sees a RESOLVE live (badge + underline fade)", async ({
    browser,
    page,
  }) => {
    const doc = await createDocument(page);

    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");
    await seedComment(page, doc.slug, SENTENCE_A, "Thread to be resolved live.");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Quarterly Report", level: 1 }),
    ).toBeVisible();
    await expect(anyBadge(page).first()).toBeVisible({ timeout: 10_000 });

    const ctxB: BrowserContext = await browser.newContext();
    const pageB = await ctxB.newPage();
    try {
      await redeemAndOpen(pageB, doc.inviteUrl, "Bob Bystander");
      const badgeB = anyBadge(pageB).first();
      await expect(badgeB).toBeVisible({ timeout: 10_000 });
      await expect(badgeB).not.toHaveAttribute("data-resolved", "true");

      // Owner resolves the thread.
      await anyBadge(page).first().click();
      const thread = threadPopover(page);
      await thread.getByRole("button", { name: "Resolve" }).click();
      await expect(thread).toContainText("Resolved");

      // The kind:"status" signal must restyle the OTHER client live: the badge
      // and the inline underline both pick up the resolved state (the underline
      // check also proves the span-rebuild path re-stamps attributes).
      let realtimeOk = true;
      try {
        await expect(badgeB).toHaveAttribute("data-resolved", "true", { timeout: 15_000 });
      } catch {
        realtimeOk = false;
      }

      if (!realtimeOk) {
        await pageB.reload();
        await expect(
          pageB.getByRole("heading", { name: "Quarterly Report", level: 1 }),
        ).toBeVisible();
        await expect(anyBadge(pageB).first()).toHaveAttribute("data-resolved", "true", {
          timeout: 10_000,
        });

        throw new Error(
          "REALTIME NOTED FAILURE: second context did not restyle the resolved " +
            "thread via broadcast within 15s; it only updated after a reload. " +
            "The status data is correct, but the realtime broadcast path is not " +
            "delivering live updates in this environment.",
        );
      }

      await expect(anyHighlight(pageB).first()).toHaveAttribute("data-resolved", "true");
    } finally {
      await ctxB.close();
    }
  });

  test("owner: ActionBar (download/copy link) + resolve works; reviewer cannot resolve", async ({
    browser,
    page,
  }) => {
    const doc = await createDocument(page);

    await redeemAndOpen(page, doc.ownerUrl, "Olivia Owner");

    // The owner controls (Download / Copy share / Participants) live in the
    // floating ActionBar. On desktop they sit in the right-edge pill and are
    // visible at rest; on mobile they are behind the bottom-right FAB, which must
    // be opened first to reveal the labelled cluster.
    const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
    if (!isDesktop) {
      await page.getByRole("button", { name: "Document actions" }).tap();
    }

    await expect(page.getByRole("button", { name: "Copy reviewer link" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download Markdown" })).toBeVisible();
    // Participants is an owner control on both surfaces.
    await expect(page.getByRole("button", { name: /Participants/ })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download Markdown" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);

    await page.evaluate(() => {
      const w = window as unknown as { __copied?: string };
      navigator.clipboard.writeText = async (text: string) => {
        w.__copied = text;
      };
    });
    // The download click collapses the mobile cluster (it's a navigation); reopen
    // the FAB so the Copy reviewer link control is reachable again.
    if (!isDesktop) {
      await page.getByRole("button", { name: "Document actions" }).tap();
    }
    await page.getByRole("button", { name: "Copy reviewer link" }).click();
    // The copy flow is async (mint share link -> write clipboard); poll the mock.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __copied?: string }).__copied),
        { timeout: 5000 },
      )
      .toContain("#t=");

    // Owner posts a comment and resolves the thread.
    await postCommentViaComposer(page, "Owner-created note to resolve.");
    await anyBadge(page).first().click();
    const ownerThread = threadPopover(page);
    await expect(ownerThread).toBeVisible();

    const resolveBtn = ownerThread.getByRole("button", { name: "Resolve" });
    await expect(resolveBtn).toBeVisible();
    await resolveBtn.click();

    await expect(ownerThread.getByRole("button", { name: "Reopen" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(ownerThread).toContainText("Resolved");

    // A reviewer joining the SAME doc must NOT see a Resolve/Reopen control.
    const ctxR: BrowserContext = await browser.newContext();
    const pageR = await ctxR.newPage();
    try {
      await redeemAndOpen(pageR, doc.inviteUrl, "Rey Reviewer");
      await expect(anyBadge(pageR).first()).toBeVisible({ timeout: 15_000 });
      await anyBadge(pageR).first().click();
      const reviewerThread = threadPopover(pageR);
      await expect(reviewerThread).toBeVisible();
      await expect(reviewerThread.getByRole("button", { name: /resolve/i })).toHaveCount(0);
      await expect(reviewerThread.getByRole("button", { name: /reopen/i })).toHaveCount(0);
    } finally {
      await ctxR.close();
    }
  });
});
