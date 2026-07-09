import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildThreads,
  dropComment,
  fetchComment,
  fetchComments,
  mergeComment,
  reconcileComments,
  reconcileWithPending,
  revokeShareLinks,
  sameComments,
  type CommentDTO,
  type ReactionGroup,
} from "../comments-api";

function comment(overrides: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: "c1",
    document_id: "d1",
    version_id: "v1",
    participant_id: "p1",
    anchor: { quote: "hello", prefix: "", suffix: "", blockId: "b1" },
    body: "body",
    parent_id: null,
    status: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    author_name: "Alice",
    reactions: [],
    ...overrides,
  };
}

describe("sameComments", () => {
  it("is true for the identical reference", () => {
    const a = [comment()];
    expect(sameComments(a, a)).toBe(true);
  });

  it("is true for structurally equal but distinct arrays", () => {
    expect(sameComments([comment()], [comment()])).toBe(true);
  });

  it("is false when length differs (reply added/removed)", () => {
    expect(sameComments([comment()], [comment(), comment({ id: "c2", parent_id: "c1" })])).toBe(
      false,
    );
  });

  it("is false on a status change", () => {
    expect(sameComments([comment()], [comment({ status: "resolved" })])).toBe(false);
  });

  it("is false on a body edit", () => {
    expect(sameComments([comment()], [comment({ body: "edited" })])).toBe(false);
  });

  it("is false on an id change (optimistic → server swap would show)", () => {
    expect(sameComments([comment()], [comment({ id: "c2" })])).toBe(false);
  });

  it("ignores author_name churn (not part of the paint signature)", () => {
    expect(sameComments([comment()], [comment({ author_name: "Bob" })])).toBe(true);
  });

  it("detects a reaction count change", () => {
    const r: ReactionGroup[] = [{ emoji: "👍", count: 1, mine: true }];
    const r2: ReactionGroup[] = [{ emoji: "👍", count: 2, mine: true }];
    expect(sameComments([comment({ reactions: r })], [comment({ reactions: r2 })])).toBe(false);
  });

  it("detects a mine-flip even when the count is unchanged", () => {
    const r: ReactionGroup[] = [{ emoji: "👍", count: 1, mine: true }];
    const r2: ReactionGroup[] = [{ emoji: "👍", count: 1, mine: false }];
    expect(sameComments([comment({ reactions: r })], [comment({ reactions: r2 })])).toBe(false);
  });

  it("is order-insensitive across reaction groups", () => {
    const r: ReactionGroup[] = [
      { emoji: "👍", count: 1, mine: true },
      { emoji: "🎉", count: 2, mine: false },
    ];
    const r2: ReactionGroup[] = [
      { emoji: "🎉", count: 2, mine: false },
      { emoji: "👍", count: 1, mine: true },
    ];
    expect(sameComments([comment({ reactions: r })], [comment({ reactions: r2 })])).toBe(true);
  });

  it("is false when the same comments arrive in a different list order", () => {
    const a = [comment({ id: "c1" }), comment({ id: "c2" })];
    const b = [comment({ id: "c2" }), comment({ id: "c1" })];
    expect(sameComments(a, b)).toBe(false);
  });

  it("both empty is equal", () => {
    expect(sameComments([], [])).toBe(true);
  });

  it("keeps adjacent fields from colliding across the delimiter", () => {
    // Under a collidable separator (e.g. a space) these two would join to the
    // SAME signature — "…(t evil)(body)…" vs "…(t)(evil body)…" — and falsely
    // compare equal. The NUL delimiter keeps every field boundary exact.
    const a = comment({ created_at: "t evil", body: "body" });
    const b = comment({ created_at: "t", body: "evil body" });
    expect(sameComments([a], [b])).toBe(false);
  });
});

describe("reconcileComments (structural sharing, perf C3)", () => {
  it("returns the SAME array reference for a structurally identical fetch", () => {
    const prev = [comment({ id: "c1" }), comment({ id: "c2", parent_id: "c1" })];
    const next = [comment({ id: "c1" }), comment({ id: "c2", parent_id: "c1" })];
    expect(reconcileComments(prev, next)).toBe(prev);
  });

  it("keeps unchanged row identities and swaps only the changed row", () => {
    const a = comment({ id: "c1" });
    const b = comment({ id: "c2" });
    const prev = [a, b];
    const changedB = comment({ id: "c2", body: "edited" });
    const result = reconcileComments(prev, [comment({ id: "c1" }), changedB]);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(a); // unchanged → previous object reused
    expect(result[1]).toBe(changedB); // changed → new server object
  });

  it("preserves the reconciled optimistic object through a trailing refetch (L5-1)", () => {
    // The optimistic object (client UUID = real id) was reconciled in place; a
    // server-shaped clone with the same signature must NOT replace it.
    const optimistic = comment({ id: "uuid-1", author_name: "You" });
    const serverClone = comment({ id: "uuid-1", author_name: "Alice" }); // author churn is not part of the signature
    const result = reconcileComments([optimistic], [serverClone]);
    expect(result[0]).toBe(optimistic);
  });

  it("handles a server-side insert (new row appears, old rows keep identity)", () => {
    const a = comment({ id: "c1" });
    const inserted = comment({ id: "c2", created_at: "2026-01-02T00:00:00.000Z" });
    const result = reconcileComments([a], [comment({ id: "c1" }), inserted]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(inserted);
  });

  it("handles a server-side delete (row disappears, survivors keep identity)", () => {
    const a = comment({ id: "c1" });
    const b = comment({ id: "c2" });
    const result = reconcileComments([a, b], [comment({ id: "c1" })]);
    expect(result).toEqual([a]);
    expect(result[0]).toBe(a);
  });

  it("adopts the server's order on a reorder while reusing row objects", () => {
    const a = comment({ id: "c1" });
    const b = comment({ id: "c2" });
    const prev = [a, b];
    const result = reconcileComments(prev, [comment({ id: "c2" }), comment({ id: "c1" })]);
    expect(result).not.toBe(prev);
    expect(result[0]).toBe(b);
    expect(result[1]).toBe(a);
  });
});

describe("reconcileWithPending (stale full refetch vs optimistic insert, audit 1.5)", () => {
  const NONE: ReadonlySet<string> = new Set();

  it("keeps a pending optimistic comment that a stale snapshot is missing", () => {
    const existing = comment({ id: "c1" });
    const optimistic = comment({ id: "uuid-1", created_at: "2026-01-02T00:00:00.000Z" });
    // The full-list request was already in flight when the user commented, so
    // its response (a pre-insert snapshot) does not contain the new row.
    const staleSnapshot = [comment({ id: "c1" })];
    const result = reconcileWithPending(
      [existing, optimistic],
      staleSnapshot,
      new Set(["uuid-1"]),
      NONE,
    );
    expect(result.map((c) => c.id)).toEqual(["c1", "uuid-1"]);
    expect(result[0]).toBe(existing); // structural sharing intact
    expect(result[1]).toBe(optimistic); // pinned row survives, identity kept
  });

  it("merges the pending row back in created_at order, not just appended", () => {
    const optimistic = comment({ id: "uuid-1", created_at: "2026-01-02T00:00:00.000Z" });
    const later = comment({ id: "c3", created_at: "2026-01-03T00:00:00.000Z" });
    const result = reconcileWithPending(
      [optimistic, later],
      [comment({ id: "c3", created_at: "2026-01-03T00:00:00.000Z" })],
      new Set(["uuid-1"]),
      NONE,
    );
    expect(result.map((c) => c.id)).toEqual(["uuid-1", "c3"]);
  });

  it("defers to the server row when the snapshot already contains the pending id", () => {
    const optimistic = comment({ id: "uuid-1", author_name: "You" });
    const server = comment({ id: "uuid-1", author_name: "Alice" });
    const result = reconcileWithPending([optimistic], [server], new Set(["uuid-1"]), NONE);
    expect(result).toHaveLength(1);
    // Same signature (author churn excluded) → previous identity is reused.
    expect(result[0]).toBe(optimistic);
  });

  it("never resurrects a pending id that was tombstoned meanwhile", () => {
    const optimistic = comment({ id: "uuid-1" });
    const result = reconcileWithPending(
      [optimistic],
      [],
      new Set(["uuid-1"]),
      new Set(["uuid-1"]),
    );
    expect(result).toEqual([]);
  });

  it("is exactly reconcileComments when nothing is pending (same-ref bailout)", () => {
    const prev = [comment({ id: "c1" })];
    expect(reconcileWithPending(prev, [comment({ id: "c1" })], NONE, NONE)).toBe(prev);
  });

  it("drops non-pending rows the server no longer returns (real remote delete)", () => {
    const a = comment({ id: "c1" });
    const b = comment({ id: "c2" });
    const result = reconcileWithPending([a, b], [comment({ id: "c1" })], NONE, NONE);
    expect(result).toEqual([a]);
  });
});

describe("mergeComment / dropComment (delta refetch, perf C4/H9)", () => {
  it("returns prev untouched when the incoming row is signature-identical", () => {
    const prev = [comment({ id: "c1" })];
    expect(mergeComment(prev, comment({ id: "c1" }))).toBe(prev);
  });

  it("swaps only the changed slot, keeping every other identity", () => {
    const a = comment({ id: "c1" });
    const b = comment({ id: "c2", created_at: "2026-01-02T00:00:00.000Z" });
    const changed = comment({ id: "c1", status: "resolved" });
    const result = mergeComment([a, b], changed);
    expect(result[0]).toBe(changed);
    expect(result[1]).toBe(b);
  });

  it("inserts a new row in created_at order (matches the server's list order)", () => {
    const a = comment({ id: "c1", created_at: "2026-01-01T00:00:00.000Z" });
    const c = comment({ id: "c3", created_at: "2026-01-03T00:00:00.000Z" });
    const b = comment({ id: "c2", created_at: "2026-01-02T00:00:00.000Z" });
    const result = mergeComment([a, c], b);
    expect(result.map((x) => x.id)).toEqual(["c1", "c2", "c3"]);
    expect(result[0]).toBe(a);
    expect(result[2]).toBe(c);
  });

  it("dropComment removes a root and its replies with survivors keeping identity", () => {
    const root = comment({ id: "c1" });
    const reply = comment({ id: "c2", parent_id: "c1" });
    const other = comment({ id: "c3" });
    const result = dropComment([root, reply, other], "c1");
    expect(result).toEqual([other]);
    expect(result[0]).toBe(other);
  });

  it("dropComment returns prev when the id is already gone", () => {
    const prev = [comment({ id: "c1" })];
    expect(dropComment(prev, "nope")).toBe(prev);
  });
});

describe("buildThreads (thread-identity structural sharing, perf C3)", () => {
  it("returns the SAME thread object when root + replies kept their identities", () => {
    const root = comment({ id: "c1" });
    const reply = comment({ id: "c2", parent_id: "c1" });
    const first = buildThreads([root, reply]);
    const second = buildThreads([root, reply]);
    expect(second[0]).toBe(first[0]);
  });

  it("keeps unchanged threads' identity when a sibling thread changes", () => {
    const rootA = comment({ id: "a" });
    const rootB = comment({ id: "b", created_at: "2026-01-02T00:00:00.000Z" });
    const first = buildThreads([rootA, rootB]);
    const changedB = comment({ id: "b", created_at: "2026-01-02T00:00:00.000Z", status: "resolved" });
    const second = buildThreads([rootA, changedB]);
    expect(second[0]).toBe(first[0]); // untouched thread reused
    expect(second[1]).not.toBe(first[1]); // changed thread re-identified
    expect(second[1]!.root).toBe(changedB);
  });

  it("re-identifies a thread when a reply is added, reusing the root object", () => {
    const root = comment({ id: "c1" });
    const first = buildThreads([root]);
    const reply = comment({ id: "c2", parent_id: "c1" });
    const second = buildThreads([root, reply]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.root).toBe(root);
    expect(second[0]!.replies).toEqual([reply]);
  });

  it("sorts replies by created_at within a thread", () => {
    const root = comment({ id: "c1" });
    const later = comment({ id: "c3", parent_id: "c1", created_at: "2026-01-03T00:00:00.000Z" });
    const earlier = comment({ id: "c2", parent_id: "c1", created_at: "2026-01-02T00:00:00.000Z" });
    const threads = buildThreads([root, later, earlier]);
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["c2", "c3"]);
  });
});

describe("fetchComment (single-comment delta GET)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the enriched comment on 200", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ comment: comment({ id: "c9" }) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mock);
    const res = await fetchComment("doc-slug", "c9");
    expect(res?.id).toBe("c9");
    expect(mock.mock.calls[0]![0]).toBe("/api/d/doc-slug/comments/c9");
  });

  it("maps a 404 to null (deleted between signal and fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Comment not found" }), { status: 404 })),
    );
    await expect(fetchComment("doc-slug", "gone")).resolves.toBeNull();
  });

  it("throws on other error statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
    );
    await expect(fetchComment("doc-slug", "c1")).rejects.toThrow("nope");
  });
});

describe("revokeShareLinks (DELETE /share, audit M5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("DELETEs the share endpoint (same-origin, no-store) and returns the revoked count", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mock);

    const revoked = await revokeShareLinks("doc-slug");

    expect(revoked).toBe(3);
    expect(mock.mock.calls[0]![0]).toBe("/api/d/doc-slug/share");
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });

  it("percent-encodes the slug in the request URL", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mock);

    await revokeShareLinks("a b/c");
    expect(mock.mock.calls[0]![0]).toBe("/api/d/a%20b%2Fc/share");
  });

  it("returns 0 when there were no live links to revoke", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ revoked: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(revokeShareLinks("doc-slug")).resolves.toBe(0);
  });

  it("throws the server error message on a non-ok status (e.g. 403 non-owner)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Owner role required" }), { status: 403 }),
      ),
    );
    await expect(revokeShareLinks("doc-slug")).rejects.toThrow("Owner role required");
  });

  it("throws the fallback message when the error body carries no message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    await expect(revokeShareLinks("doc-slug")).rejects.toThrow(
      "Failed to revoke reviewer links",
    );
  });
});

describe("fetchComments (conditional GET)", () => {
  const ETAG = 'W/"c:1:t:r:0::o0"';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(res: Response): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("sends no If-None-Match without a stored validator and returns body + ETag", async () => {
    const mock = stubFetch(
      new Response(JSON.stringify({ comments: [comment()] }), {
        status: 200,
        headers: { ETag: ETAG, "Content-Type": "application/json" },
      }),
    );
    const res = await fetchComments("doc-slug");
    expect(res.notModified).toBe(false);
    expect(res.comments).toHaveLength(1);
    expect(res.etag).toBe(ETAG);
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });

  it("echoes the stored validator as If-None-Match", async () => {
    const mock = stubFetch(
      new Response(JSON.stringify({ comments: [] }), {
        status: 200,
        headers: { ETag: ETAG, "Content-Type": "application/json" },
      }),
    );
    await fetchComments("doc-slug", ETAG);
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ "If-None-Match": ETAG });
  });

  it("maps a 304 to notModified with a null body and the validator preserved", async () => {
    stubFetch(new Response(null, { status: 304 }));
    const res = await fetchComments("doc-slug", ETAG);
    expect(res.notModified).toBe(true);
    expect(res.comments).toBeNull();
    // The caller must keep refetching with the SAME validator it sent.
    expect(res.etag).toBe(ETAG);
  });

  it("a fresh 200 replaces the validator", async () => {
    const NEXT = 'W/"c:2:t2:r:0::o0"';
    stubFetch(
      new Response(JSON.stringify({ comments: [] }), {
        status: 200,
        headers: { ETag: NEXT, "Content-Type": "application/json" },
      }),
    );
    const res = await fetchComments("doc-slug", ETAG);
    expect(res.notModified).toBe(false);
    expect(res.etag).toBe(NEXT);
  });

  it("throws on an error status instead of caching it", async () => {
    stubFetch(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    await expect(fetchComments("doc-slug", ETAG)).rejects.toThrow("nope");
  });
});
