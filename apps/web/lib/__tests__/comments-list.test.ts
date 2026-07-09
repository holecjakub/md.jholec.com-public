import { afterEach, describe, expect, it, vi } from "vitest";

// listEnrichedComments reaches the DB only through admin(); stub it so tests can
// serve deterministic pages from in-memory tables (M4 paging behavior).
const adminMock = vi.fn();
vi.mock("@/lib/db/admin", () => ({
  admin: () => adminMock(),
}));

import { fetchAllRows, listEnrichedComments, MAX_ROWS, PAGE_SIZE } from "../comments/list";

/** fetchPage stub that serves slices of `rows` and records every range asked for. */
function pagedSource(rows: unknown[]) {
  const ranges: Array<[number, number]> = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  return { fetchPage, ranges };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Guards the audit-M4 fix: PostgREST silently truncates un-ranged selects at
 * max_rows (1000 on Supabase), so the list path must page with .range() using
 * contiguous, non-overlapping windows, stop on the first short page, surface
 * per-page errors, and cap at MAX_ROWS instead of paging forever.
 */
describe("fetchAllRows — explicit paging past PostgREST max_rows", () => {
  it("a single short page returns as-is after ONE fetch with the right range", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}` }));
    const { fetchPage, ranges } = pagedSource(rows);

    await expect(fetchAllRows(fetchPage, "comments")).resolves.toEqual(rows);
    expect(ranges).toEqual([[0, PAGE_SIZE - 1]]);
  });

  it("an empty result (data: null) returns [] without a second fetch", async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: null }));

    await expect(fetchAllRows(fetchPage, "comments")).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("pages with contiguous, non-overlapping ranges and keeps row order", async () => {
    const rows = Array.from({ length: PAGE_SIZE + 500 }, (_, i) => ({ id: `r${i}` }));
    const { fetchPage, ranges } = pagedSource(rows);

    const all = await fetchAllRows(fetchPage, "comments");

    expect(ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
    expect(all).toHaveLength(rows.length);
    expect(all[0]).toEqual({ id: "r0" });
    expect(all[PAGE_SIZE]).toEqual({ id: `r${PAGE_SIZE}` }); // page seam: no overlap, no gap
    expect(all[all.length - 1]).toEqual({ id: `r${rows.length - 1}` });
  });

  it("an exact multiple of PAGE_SIZE needs one extra (empty) probe page", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `r${i}` }));
    const { fetchPage, ranges } = pagedSource(rows);

    await expect(fetchAllRows(fetchPage, "comments")).resolves.toEqual(rows);
    // A full first page cannot prove the end — the empty second page does.
    expect(ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
  });

  it("a page error throws with the label (no silent partial result)", async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: { message: "boom" } }));

    await expect(fetchAllRows(fetchPage, "reactions")).rejects.toThrow(
      "Failed to list reactions",
    );
  });

  it("an error on a LATER page throws too — never returns a truncated prefix as success", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: `r${i}` }));
    const fetchPage = vi.fn(async (from: number, to: number) =>
      from === 0
        ? { data: rows.slice(from, to + 1), error: null }
        : { data: null, error: { message: "boom" } },
    );

    await expect(fetchAllRows(fetchPage, "comments")).rejects.toThrow(
      "Failed to list comments",
    );
  });

  it("stops at the MAX_ROWS ceiling with a loud warn instead of paging forever", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pathological source: every page is full, no matter how far we page.
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `r${from + i}` })),
      error: null,
    }));

    const all = await fetchAllRows(fetchPage, "comments");

    expect(all).toHaveLength(MAX_ROWS);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_ROWS / PAGE_SIZE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MAX_ROWS"));
  });

  it("MAX_ROWS is a whole number of pages (the loop's exit arithmetic relies on it)", () => {
    expect(MAX_ROWS % PAGE_SIZE).toBe(0);
  });
});

/**
 * Chainable PostgREST query-builder stub: every filter/order call returns the
 * builder; .range() slices the table; awaiting resolves { data, error } like a
 * real PostgrestFilterBuilder thenable.
 */
function stubDb(tables: Record<string, Record<string, unknown>[]>) {
  const ranges: Record<string, Array<[number, number]>> = {};
  return {
    ranges,
    from(table: string) {
      let slice: unknown[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        range(from: number, to: number) {
          (ranges[table] ??= []).push([from, to]);
          slice = (tables[table] ?? []).slice(from, to + 1);
          return builder;
        },
        then(
          onFulfilled: (v: { data: unknown[]; error: null }) => unknown,
          onRejected?: (err: unknown) => unknown,
        ) {
          return Promise.resolve({ data: slice, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

describe("listEnrichedComments — pages BOTH queries and enriches across the seam", () => {
  it("returns >PAGE_SIZE comments in order, with author names and `mine` reactions", async () => {
    const total = PAGE_SIZE + 3;
    const comments = Array.from({ length: total }, (_, i) => ({
      id: `c${i}`,
      participant: { display_name: `Author ${i}` },
    }));
    const reactions = [
      // On the FIRST page's comment…
      { comment_id: "c0", emoji: "👍", participant_id: "me" },
      { comment_id: "c0", emoji: "👍", participant_id: "other" },
      // …and on a comment that only arrives with the SECOND page.
      { comment_id: `c${PAGE_SIZE + 1}`, emoji: "🎉", participant_id: "other" },
    ];
    const db = stubDb({ comments, reactions });
    adminMock.mockReturnValue(db);

    const result = await listEnrichedComments("d1", "me");

    expect(result).toHaveLength(total);
    expect(db.ranges.comments).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
    expect(db.ranges.reactions).toEqual([[0, PAGE_SIZE - 1]]);

    // Order survives the page seam; the participants embed is flattened.
    expect(result[0]).toMatchObject({ id: "c0", author_name: "Author 0" });
    expect(result[total - 1]).toMatchObject({
      id: `c${total - 1}`,
      author_name: `Author ${total - 1}`,
    });
    // Reactions group by emoji with the caller's `mine` flag — including on a
    // comment fetched by the second page.
    expect(result[0]!.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
    expect(result[PAGE_SIZE + 1]!.reactions).toEqual([{ emoji: "🎉", count: 1, mine: false }]);
    expect(result[1]!.reactions).toEqual([]);
  });
});
