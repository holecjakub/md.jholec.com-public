import { test, expect } from "@playwright/test";
import { seedDocument } from "./_helpers";

/**
 * End-to-end coverage for the comments conditional GET (perf M2): the server's
 * cheap freshness probe answers 304 to a matching If-None-Match, and every
 * comment/reaction mutation moves the validator so a stale client always gets a
 * full 200 body. This is the server half of the useComments etagRef flow — the
 * client half (echoing the validator, keeping state on 304) is unit-tested in
 * lib/__tests__/comments-api.test.ts.
 */

test("comments GET revalidates via ETag: 304 when unchanged, fresh 200 after mutations", async ({
  page,
}) => {
  const doc = await seedDocument(page.request, {
    title: "E2E Comments ETag Doc",
    password: "test-password",
  });

  // Redeem the invite token through the gate so the browser context holds a
  // participant session cookie; page.request shares that cookie jar.
  await page.goto(doc.shareUrl.slice(doc.shareUrl.indexOf("/d/")));
  await page.getByLabel("Name").fill("ETag Reviewer");
  await page.getByRole("button", { name: "View document" }).click();
  await expect(page.getByRole("heading", { name: "Quarterly Report", level: 1 })).toBeVisible();

  const commentsUrl = `/api/d/${doc.slug}/comments`;

  // 1. Unconditional GET → full 200 with a weak validator and private revalidation.
  const first = await page.request.get(commentsUrl);
  expect(first.status()).toBe(200);
  const etag = first.headers()["etag"];
  expect(etag, "comments GET must carry an ETag").toMatch(/^W\//);
  expect(first.headers()["cache-control"]).toBe("private, no-cache");

  // 2. Conditional GET with the echoed validator → 304, empty body, ~0 bytes.
  const revalidated = await page.request.get(commentsUrl, {
    headers: { "If-None-Match": etag },
  });
  expect(revalidated.status()).toBe(304);
  expect(await revalidated.text()).toBe("");
  expect(revalidated.headers()["etag"]).toBe(etag);

  // 3. A new comment moves the validator: the stale ETag now gets a full 200.
  const created = await page.request.post(commentsUrl, {
    data: {
      anchor: { quote: "Highlights", prefix: "", suffix: "", blockId: "block-1" },
      body: "Freshness probe test comment",
    },
  });
  expect(created.status()).toBe(201);
  const { comment } = (await created.json()) as { comment: { id: string } };

  const afterComment = await page.request.get(commentsUrl, {
    headers: { "If-None-Match": etag },
  });
  expect(afterComment.status()).toBe(200);
  const etagAfterComment = afterComment.headers()["etag"];
  expect(etagAfterComment).not.toBe(etag);
  const body = (await afterComment.json()) as { comments: { id: string }[] };
  expect(body.comments.some((c) => c.id === comment.id)).toBe(true);

  // 4. The fresh validator revalidates again…
  const settled = await page.request.get(commentsUrl, {
    headers: { "If-None-Match": etagAfterComment },
  });
  expect(settled.status()).toBe(304);

  // 5. …until a reaction moves it too (reactions fold into the probe, so a
  // react/unreact never gets masked by a 304).
  const reacted = await page.request.post(`${commentsUrl}/${comment.id}/react`, {
    data: { emoji: "👍" },
  });
  expect(reacted.ok()).toBe(true);

  const afterReaction = await page.request.get(commentsUrl, {
    headers: { "If-None-Match": etagAfterComment },
  });
  expect(afterReaction.status()).toBe(200);
  expect(afterReaction.headers()["etag"]).not.toBe(etagAfterComment);
});
