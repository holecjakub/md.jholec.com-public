import { test, expect, type Page } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * Concurrency guards (audit gap 2.3).
 *
 * Batch-B added the two-client realtime delete/resolve specs. Still missing were
 * the concurrent WRITE races this suite covers, asserted against the AUTHORITATIVE
 * API state (a GET of the comment list) rather than cross-client realtime DOM
 * delivery — so the assertions are deterministic even when realtime propagation
 * soft-fails between browser contexts:
 *
 *   1. Two participants POST comments concurrently (distinct ids) → both threads
 *      survive; none is lost or duplicated.
 *   2. A reaction double-tap against the toggle ends in the correct on/off state
 *      and NEVER accumulates a duplicate row (UNIQUE(comment_id,participant_id,emoji)).
 *   3. Two participants react with the SAME emoji concurrently → both counted.
 */

const SENTENCE = "Revenue grew twelve percent this period.";

const CONTENT = [
  "# Quarterly Report",
  "",
  "## Summary",
  "",
  SENTENCE,
  "",
].join("\n");

interface Doc {
  slug: string;
  invitePath: string;
}

async function createDoc(page: Page): Promise<Doc> {
  const doc = await seedDocument(page.request, {
    title: "Concurrency Doc",
    content: CONTENT,
    password: "test-password",
  });
  return { slug: doc.slug, invitePath: doc.shareUrl.slice(doc.shareUrl.indexOf("/d/")) };
}

/** Open a fresh reviewer browser context and redeem the invite as `name`. */
async function newReviewer(page: Page, invitePath: string, name: string): Promise<Page> {
  const ctx = await page.context().browser()!.newContext();
  const rp = await ctx.newPage();
  await rp.goto(invitePath);
  await expect(rp.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await rp.getByLabel("Name").fill(name);
  await rp.getByRole("button", { name: "View document" }).click();
  await expect(rp.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();
  return rp;
}

/** Resolve the [data-block-id] for the block containing `SENTENCE`. */
async function blockIdFor(page: Page, sentence: string): Promise<string> {
  const blockId = await page.evaluate((s) => {
    const blocks = Array.from(document.querySelectorAll("[data-block-id]"));
    return blocks.find((b) => (b.textContent ?? "").includes(s))?.getAttribute("data-block-id") ?? null;
  }, sentence);
  if (!blockId) throw new Error(`no [data-block-id] block for "${sentence}"`);
  return blockId;
}

interface ListedComment {
  id: string;
  body: string;
  parent_id: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
}

/**
 * Authoritative comment list, read with an AUTHENTICATED participant's request
 * context (the comments API requires a session — the default test `page` never
 * redeems the invite, so reading through it would 401).
 */
async function listComments(page: Page, slug: string): Promise<ListedComment[]> {
  const res = await page.request.get(`/api/d/${slug}/comments`);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { comments: ListedComment[] };
  return body.comments;
}

/** Total (global) count for `emoji` on comment `id`, 0 when absent. */
function reactionCount(comments: ListedComment[], id: string, emoji: string): number {
  const c = comments.find((x) => x.id === id);
  return c?.reactions.find((r) => r.emoji === emoji)?.count ?? 0;
}

test.describe("concurrent comment + reaction races", () => {
  test("two clients posting comments concurrently create two distinct threads — none lost or duplicated", async ({
    page,
  }) => {
    const doc = await createDoc(page);
    const alice = await newReviewer(page, doc.invitePath, "Alice Adams");
    const bob = await newReviewer(page, doc.invitePath, "Bob Brown");

    const blockId = await blockIdFor(alice, SENTENCE);
    const anchor = { quote: SENTENCE, prefix: "", suffix: "", blockId };

    // Both participants POST at the same time on the same block, distinct bodies.
    const [aliceRes, bobRes] = await Promise.all([
      alice.request.post(`/api/d/${doc.slug}/comments`, {
        data: { anchor, body: "Alice: is this YoY or QoQ?" },
      }),
      bob.request.post(`/api/d/${doc.slug}/comments`, {
        data: { anchor, body: "Bob: please add the source." },
      }),
    ]);
    expect(aliceRes.status(), await aliceRes.text()).toBe(201);
    expect(bobRes.status(), await bobRes.text()).toBe(201);

    const aliceId = ((await aliceRes.json()) as { comment: { id: string } }).comment.id;
    const bobId = ((await bobRes.json()) as { comment: { id: string } }).comment.id;
    expect(aliceId).not.toBe(bobId);

    // Authoritative state: exactly two top-level threads, both present, no dupes.
    const comments = await listComments(alice, doc.slug);
    const topLevel = comments.filter((c) => c.parent_id === null);
    expect(topLevel).toHaveLength(2);
    const ids = topLevel.map((c) => c.id).sort();
    expect(ids).toEqual([aliceId, bobId].sort());
    const bodies = topLevel.map((c) => c.body).sort();
    expect(bodies).toEqual(["Alice: is this YoY or QoQ?", "Bob: please add the source."].sort());

    await alice.context().close();
    await bob.context().close();
  });

  test("reaction double-tap toggles off and never duplicates the row", async ({ page }) => {
    const doc = await createDoc(page);
    const alice = await newReviewer(page, doc.invitePath, "Alice Adams");

    const blockId = await blockIdFor(alice, SENTENCE);
    const created = await alice.request.post(`/api/d/${doc.slug}/comments`, {
      data: { anchor: { quote: SENTENCE, prefix: "", suffix: "", blockId }, body: "Nice." },
    });
    expect(created.status(), await created.text()).toBe(201);
    const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

    const reactUrl = `/api/d/${doc.slug}/comments/${commentId}/react`;
    const tap = () => alice.request.post(reactUrl, { data: { emoji: "👍" } });

    // Sequential double-tap: ON then OFF → deterministic net-off, count 0.
    const on = await tap();
    expect([200, 201]).toContain(on.status());
    expect(reactionCount(await listComments(alice, doc.slug), commentId, "👍")).toBe(1);

    const off = await tap();
    expect(off.status()).toBe(200);
    expect(reactionCount(await listComments(alice, doc.slug), commentId, "👍")).toBe(0);

    // Concurrent double-tap from off: the toggle races, but the UNIQUE index means
    // the final count is a consistent single state (0 or 1) — never a duplicate row.
    await Promise.all([tap(), tap()]);
    const raced = reactionCount(await listComments(alice, doc.slug), commentId, "👍");
    expect(raced, `same participant+emoji must never accumulate (got ${raced})`).toBeLessThanOrEqual(1);
    expect(raced).toBeGreaterThanOrEqual(0);

    await alice.context().close();
  });

  test("two participants react with the same emoji concurrently — both counted, none lost", async ({
    page,
  }) => {
    const doc = await createDoc(page);
    const alice = await newReviewer(page, doc.invitePath, "Alice Adams");
    const bob = await newReviewer(page, doc.invitePath, "Bob Brown");

    const blockId = await blockIdFor(alice, SENTENCE);
    const created = await alice.request.post(`/api/d/${doc.slug}/comments`, {
      data: { anchor: { quote: SENTENCE, prefix: "", suffix: "", blockId }, body: "Reactions please." },
    });
    expect(created.status(), await created.text()).toBe(201);
    const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

    const reactUrl = `/api/d/${doc.slug}/comments/${commentId}/react`;
    const [aliceReact, bobReact] = await Promise.all([
      alice.request.post(reactUrl, { data: { emoji: "🎉" } }),
      bob.request.post(reactUrl, { data: { emoji: "🎉" } }),
    ]);
    expect([200, 201]).toContain(aliceReact.status());
    expect([200, 201]).toContain(bobReact.status());

    // Two distinct participants, same emoji → global count is exactly 2.
    expect(reactionCount(await listComments(alice, doc.slug), commentId, "🎉")).toBe(2);

    await alice.context().close();
    await bob.context().close();
  });
});
