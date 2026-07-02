import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedDocument } from "./_helpers";

/**
 * Coverage for the redesigned right-margin block badges and the unified in-thread
 * reaction bar.
 *
 * Badges: per block, an avatar stack + (when present) a reaction total chip + (for
 * multi-thread blocks) a legible thread-count chip. On desktop every badge is
 * LEFT-anchored just outside the prose column, so their avatar stacks line up in a
 * single x-column down the gutter.
 *
 * Reaction bar: ONE row that merges the old count-summary and quick-react picker —
 * an emoji with reactions is a pressed/unpressed pill carrying its count; an emoji
 * with none is a round add-button. One tap toggles a reaction (no confirm step);
 * tapping again removes it.
 */

const CONTENT = [
  "# Quarterly Report",
  "",
  "## Summary",
  "",
  "Highlights of the quarter are summarized in this opening paragraph for review.",
  "",
  "Revenue grew twelve percent this period. Churn fell to a record low of two percent.",
  "",
  "The roadmap for next quarter focuses on three pillars of durable growth.",
  "",
].join("\n");

const B1 = "Highlights of the quarter"; // single thread, no reactions
const S_A = "Revenue grew twelve percent this period."; // multi-thread block + reactions
const S_B = "Churn fell to a record low of two percent.";
const B3 = "The roadmap for next quarter"; // single thread + reaction

interface Doc {
  slug: string;
  invitePath: string;
  ownerPath: string;
}

async function createDoc(page: Page): Promise<Doc> {
  const doc = await seedDocument(page.request, {
    title: "Badge + Reactions Doc",
    content: CONTENT,
    password: "test-password",
  });
  const toPath = (u: string) => u.slice(u.indexOf("/d/"));
  return { slug: doc.slug, invitePath: toPath(doc.shareUrl), ownerPath: toPath(doc.ownerUrl) };
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

async function postComment(page: Page, slug: string, sentence: string, body: string) {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    const el = blocks.find((b) => (b.textContent ?? "").includes(s));
    return el?.getAttribute("data-block-id") ?? null;
  }, sentence);
  if (!blockId) throw new Error(`no [data-block-id] block for "${sentence}"`);
  const res = await page.request.post(`/api/d/${slug}/comments`, {
    data: { anchor: { quote: sentence, prefix: "", suffix: "", blockId }, body },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { comment: { id: string } };
}

async function react(page: Page, slug: string, commentId: string, emoji: string) {
  const res = await page.request.post(`/api/d/${slug}/comments/${commentId}/react`, {
    data: { emoji },
  });
  expect([200, 201]).toContain(res.status());
}

function badges(page: Page) {
  return page.locator('button[aria-label*="comment thread"]');
}

function threadPopover(page: Page) {
  return page.getByRole("dialog", { name: "Comment thread" });
}

/** Seed a doc with three reviewers so badges carry multiple authors + reactions. */
async function seedDoc(page: Page): Promise<Doc> {
  const doc = await createDoc(page);
  const reviewers: Page[] = [];
  for (const name of ["Alice Adams", "Bob Brown", "Carol Chen"]) {
    const ctx = await page.context().browser()!.newContext();
    const rp = await ctx.newPage();
    await redeem(rp, doc.invitePath, name);
    reviewers.push(rp);
  }
  const [alice, bob, carol] = reviewers;

  await postComment(alice, doc.slug, B1, "Can we cite the source here?");

  const cA = await postComment(alice, doc.slug, S_A, "Is this YoY or QoQ?");
  await postComment(bob, doc.slug, S_B, "Great improvement on churn.");
  await react(alice, doc.slug, cA.comment.id, "👍");
  await react(bob, doc.slug, cA.comment.id, "👍");
  await react(carol, doc.slug, cA.comment.id, "🎉");

  const c3 = await postComment(carol, doc.slug, B3, "Love this direction.");
  await react(bob, doc.slug, c3.comment.id, "🚀");

  for (const rp of reviewers) await rp.context().close();
  return doc;
}

test.describe("Block badges + unified reaction bar", () => {
  test("badges show avatar stack + reaction total + thread-count chip; desktop avatars align in one column", async ({
    page,
  }) => {
    const doc = await seedDoc(page);
    await redeem(page, doc.ownerPath, "Olivia Owner");
    await expect(badges(page).first()).toBeVisible({ timeout: 10_000 });
    // Three commented blocks → three badges.
    await expect(badges(page)).toHaveCount(3, { timeout: 10_000 });

    // The two-sentence block has TWO threads and reactions: its badge carries the
    // reaction total (👍×2 + 🎉×1 = 3) and a legible "2" thread-count chip.
    const multiBadge = page.locator('button[aria-label*="2 comment threads"]');
    await expect(multiBadge).toBeVisible();
    await expect(multiBadge).toContainText("3"); // reaction total
    await expect(multiBadge).toContainText("2"); // thread count

    // Desktop only: badges are left-anchored, so their LEFT edges line up (a clean
    // avatar column). Mobile anchors each below its block, so skip there.
    const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
    if (isDesktop) {
      const lefts = await badges(page).evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().left)),
      );
      const min = Math.min(...lefts);
      const max = Math.max(...lefts);
      expect(max - min, `badge left edges should align (got ${JSON.stringify(lefts)})`).toBeLessThanOrEqual(2);
    }
  });

  test("reaction bar: reacted emoji is a pill with count, others are add-buttons; owner taps toggle on/off", async ({
    page,
  }) => {
    const doc = await seedDoc(page);
    await redeem(page, doc.ownerPath, "Olivia Owner");
    await expect(badges(page).first()).toBeVisible({ timeout: 10_000 });

    // Open the single-thread roadmap block (one 🚀 reaction, no owner reaction yet).
    const roadmapBadge = page.locator('button[aria-label*="comment thread"]').filter({
      hasText: "🚀",
    });
    await roadmapBadge.first().click();
    const thread = threadPopover(page);
    await expect(thread).toBeVisible();

    // Every palette emoji (👍 ❤️ 🎉 😕) renders as a single toggle in the unified
    // bar — either an add-button ("React: …") or, if reacted, a pill ("Remove …").
    for (const label of ["Looks good", "Love it", "Celebrate", "Confused"]) {
      await expect(
        thread.getByRole("button", { name: new RegExp(`(React: ${label}|Remove your ${label})`) }),
      ).toBeVisible();
    }

    // Owner taps 👍: instant toggle ON → pressed pill with count 1, named "Remove…".
    await thread.getByRole("button", { name: "React: Looks good" }).click();
    const myPill = thread.getByRole("button", { name: "Remove your Looks good reaction" });
    await expect(myPill).toBeVisible({ timeout: 10_000 });
    await expect(myPill).toHaveAttribute("aria-pressed", "true");
    await expect(myPill).toContainText("1");

    // An un-reacted palette emoji stays an unpressed add-button with no count.
    const confused = thread.getByRole("button", { name: "React: Confused" });
    await expect(confused).toHaveAttribute("aria-pressed", "false");
    await expect(confused).not.toContainText(/\d/);

    // Tap again → toggles OFF (unselect removes the reaction).
    await myPill.click();
    await expect(
      thread.getByRole("button", { name: "React: Looks good" }),
    ).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });

    // a11y on the open popover (the reaction bar is the new surface).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector('[aria-label="Comment thread"]');
          return el ? Number(getComputedStyle(el).opacity) : 0;
        }),
      )
      .toBeGreaterThanOrEqual(1);
    const results = await new AxeBuilder({ page })
      .include('[aria-label="Comment thread"]')
      .analyze();
    const serious = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);
  });
});
