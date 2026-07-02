import { test, expect, type Page } from "@playwright/test";
import { parseComments, COMMENTS_MARKER } from "@md/core";
import { seedDocument } from "./_helpers";

/**
 * #21 (part 1) — comments are embedded in the downloaded source .md and round-trip:
 * the /download endpoint appends an md.jholec.com/comments appendix (author, body,
 * anchor, reactions, replies); it parses back via @md/core; and re-uploading a
 * downloaded file stores clean content (the appendix is stripped, never shown).
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
    title: "Export Doc",
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

test("download embeds comments; they round-trip; re-upload stores clean content", async ({
  page,
  browser,
}) => {
  const doc = await createDoc(page);

  // A reviewer leaves a comment + a reaction.
  const reviewerCtx = await browser.newContext();
  const reviewer = await reviewerCtx.newPage();
  await redeem(reviewer, doc.invitePath, "Rita Reviewer");
  const blockId = await reviewer.evaluate((s) => {
    const el = Array.from(document.querySelectorAll("[data-block-id]")).find((b) =>
      (b.textContent ?? "").includes(s),
    );
    return el?.getAttribute("data-block-id") ?? null;
  }, QUOTE);
  const created = await reviewer.request.post(`/api/d/${doc.slug}/comments`, {
    data: { anchor: { quote: QUOTE, prefix: "", suffix: "", blockId }, body: "Please cite this." },
  });
  expect(created.status()).toBe(201);
  const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;
  await reviewer.request.post(`/api/d/${doc.slug}/comments/${commentId}/react`, {
    data: { emoji: "👍" },
  });
  await reviewerCtx.close();

  // The owner downloads the .md — it carries the embedded appendix.
  await redeem(page, doc.ownerPath, "Olivia Owner");
  const dl = await page.request.get(`/api/d/${doc.slug}/download`);
  expect(dl.status()).toBe(200);
  const md = await dl.text();
  expect(md).toContain(`<!-- ${COMMENTS_MARKER} v1`);
  expect(md.startsWith("# Quarterly Report")).toBe(true); // appendix is at the end

  // It round-trips through @md/core.
  const { content, threads } = parseComments(md);
  expect(content.trimEnd()).toBe(CONTENT.trimEnd());
  expect(threads).toHaveLength(1);
  expect(threads[0]!.body).toBe("Please cite this.");
  expect(threads[0]!.author).toBe("Rita Reviewer");
  expect(threads[0]!.anchor.quote).toBe(QUOTE);
  expect(threads[0]!.reactions).toContainEqual({ emoji: "👍", count: 1 });

  // Re-uploading the downloaded file stores CLEAN content (appendix stripped) —
  // it must never surface as literal markdown in the document body.
  const reupDoc = await seedDocument(page.request, {
    title: "Re-uploaded",
    content: md,
    password: "test-password",
  });
  const reupOwnerPath = reupDoc.ownerUrl.slice(reupDoc.ownerUrl.indexOf("/d/"));

  // Open the new doc as owner and download it — it has no comments, so the
  // appendix must be ABSENT and the body equals the original clean content.
  await redeem(page, reupOwnerPath, "Olivia Owner");
  const reDl = await page.request.get(`/api/d/${reupDoc.slug}/download`);
  expect(reDl.status()).toBe(200);
  const reMd = await reDl.text();
  expect(reMd).not.toContain(COMMENTS_MARKER);
  expect(reMd.trimEnd()).toBe(CONTENT.trimEnd());
});
