import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeltaQueue, MAX_DELTA_IDS, REFETCH_DEBOUNCE_MS } from "../comments-delta";
import type { CommentDTO } from "../comments-api";

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

/** A manually resolvable promise, to interleave in-flight GETs deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Test harness around createDeltaQueue: holds a plain comments array as the
 * "state", records every dependency call, and lets tests script fetchOne
 * responses per id (value, null for 404, rejection, or a deferred).
 */
function harness(initial: CommentDTO[] = []) {
  let state = initial;
  const tombstones = new Set<string>();
  const fetchOne = vi.fn<(id: string) => Promise<CommentDTO | null>>();
  const refetchAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const clearError = vi.fn();
  const queue = createDeltaQueue({
    fetchOne,
    refetchAll,
    applyComments: (updater) => {
      state = updater(state);
    },
    clearError,
    tombstones,
  });
  return {
    queue,
    fetchOne,
    refetchAll,
    clearError,
    tombstones,
    get state() {
      return state;
    },
  };
}

/** Run the debounce timer and drain the microtask queue so the flush settles. */
async function settle() {
  await vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createDeltaQueue — delta merge path", () => {
  it("fetches just the ONE signalled comment and merges it (no full refetch)", async () => {
    const existing = comment({ id: "c1" });
    const h = harness([existing]);
    const incoming = comment({ id: "c2", created_at: "2026-01-02T00:00:00.000Z" });
    h.fetchOne.mockResolvedValueOnce(incoming);

    h.queue.signal({ kind: "comment", commentId: "c2" });
    await settle();

    expect(h.fetchOne).toHaveBeenCalledTimes(1);
    expect(h.fetchOne).toHaveBeenCalledWith("c2");
    expect(h.refetchAll).not.toHaveBeenCalled();
    expect(h.state).toEqual([existing, incoming]);
    expect(h.clearError).toHaveBeenCalledTimes(1);
  });

  it("debounces a burst on the same id into ONE fetch", async () => {
    const h = harness();
    h.fetchOne.mockResolvedValue(comment({ id: "c1" }));

    h.queue.signal({ kind: "comment", commentId: "c1" });
    h.queue.signal({ kind: "reaction", commentId: "c1" });
    h.queue.signal({ kind: "status", commentId: "c1" });
    await settle();

    expect(h.fetchOne).toHaveBeenCalledTimes(1);
    expect(h.refetchAll).not.toHaveBeenCalled();
  });

  it("a signal WITHOUT a payload falls back to a full refetch", async () => {
    const h = harness();

    h.queue.signal();
    await settle();

    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.fetchOne).not.toHaveBeenCalled();
  });

  it("a delta failure degrades to the full-list refetch", async () => {
    const h = harness([comment({ id: "c1" })]);
    h.fetchOne.mockRejectedValueOnce(new Error("network"));

    h.queue.signal({ kind: "status", commentId: "c1" });
    await settle();

    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.clearError).not.toHaveBeenCalled();
  });

  it("dispose() cancels a pending flush entirely", async () => {
    const h = harness();

    h.queue.signal({ kind: "comment", commentId: "c1" });
    h.queue.dispose();
    await settle();

    expect(h.fetchOne).not.toHaveBeenCalled();
    expect(h.refetchAll).not.toHaveBeenCalled();
  });

  it("an in-flight fetch result is discarded after dispose()", async () => {
    const h = harness();
    const d = deferred<CommentDTO | null>();
    h.fetchOne.mockReturnValueOnce(d.promise);

    h.queue.signal({ kind: "comment", commentId: "c1" });
    await settle();
    h.queue.dispose();
    d.resolve(comment({ id: "c1" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.state).toEqual([]);
    expect(h.clearError).not.toHaveBeenCalled();
  });
});

describe("createDeltaQueue — delete is fetch-and-verify (untrusted broadcast)", () => {
  it("a REAL delete drops the row only after the GET confirms it (404) and tombstones the id", async () => {
    const root = comment({ id: "c1" });
    const reply = comment({ id: "c2", parent_id: "c1" });
    const h = harness([root, reply]);
    h.fetchOne.mockResolvedValueOnce(null); // 404 — server-confirmed delete

    h.queue.signal({ kind: "delete", commentId: "c1" });
    // The drop is NOT applied synchronously from the payload…
    expect(h.state).toEqual([root, reply]);
    await settle();

    // …only after the authenticated GET 404s. Replies go with the root.
    expect(h.fetchOne).toHaveBeenCalledWith("c1");
    expect(h.state).toEqual([]);
    expect(h.tombstones.has("c1")).toBe(true);
    expect(h.refetchAll).not.toHaveBeenCalled();
  });

  it("a SPOOFED delete for a live comment is a no-op (row survives, no tombstone)", async () => {
    const live = comment({ id: "c1" });
    const h = harness([live]);
    h.fetchOne.mockResolvedValueOnce(live); // server says: still alive

    h.queue.signal({ kind: "delete", commentId: "c1" });
    await settle();

    expect(h.state).toEqual([live]);
    expect(h.state[0]).toBe(live); // structural sharing kept the reference
    expect(h.tombstones.size).toBe(0);
  });

  it("never merges a tombstoned id, even when the GET returns a stale row", async () => {
    const stale = comment({ id: "c1" });
    const h = harness([]);
    h.tombstones.add("c1"); // e.g. the local DELETE already confirmed
    h.fetchOne.mockResolvedValueOnce(stale); // pre-delete row raced the DELETE

    h.queue.signal({ kind: "reaction", commentId: "c1" });
    await settle();

    expect(h.state).toEqual([]);
  });

  it("GHOST RACE: an in-flight GET resolving with the pre-delete row after the 404 cannot resurrect it", async () => {
    const preDelete = comment({ id: "c1" });
    const h = harness([preDelete]);
    const slowGet = deferred<CommentDTO | null>(); // flush 1: mutation signal's GET
    const deleteGet = deferred<CommentDTO | null>(); // flush 2: delete signal's GET
    h.fetchOne.mockReturnValueOnce(slowGet.promise).mockReturnValueOnce(deleteGet.promise);

    // Flush 1 starts (e.g. a resolve-then-delete: the "status" signal's GET is
    // in flight when the comment is deleted server-side).
    h.queue.signal({ kind: "status", commentId: "c1" });
    await settle();
    // Flush 2: the delete broadcast arrives and its verify-GET 404s FIRST.
    h.queue.signal({ kind: "delete", commentId: "c1" });
    await settle();
    deleteGet.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state).toEqual([]);
    expect(h.tombstones.has("c1")).toBe(true);

    // Now the SLOW pre-delete GET resolves — the tombstone must block the merge.
    slowGet.resolve(preDelete);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state).toEqual([]);
  });
});

describe("createDeltaQueue — fan-out cap", () => {
  it("collapses a burst past MAX_DELTA_IDS distinct ids into ONE full refetch (zero single GETs)", async () => {
    const h = harness();

    for (let i = 0; i <= MAX_DELTA_IDS; i++) {
      h.queue.signal({ kind: "comment", commentId: `spoofed-${i}` });
    }
    await settle();

    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.fetchOne).not.toHaveBeenCalled();
  });

  it("stays on the delta path at exactly MAX_DELTA_IDS distinct ids", async () => {
    const h = harness();
    h.fetchOne.mockResolvedValue(null);

    for (let i = 0; i < MAX_DELTA_IDS; i++) {
      h.queue.signal({ kind: "comment", commentId: `c${i}` });
    }
    await settle();

    expect(h.fetchOne).toHaveBeenCalledTimes(MAX_DELTA_IDS);
    expect(h.refetchAll).not.toHaveBeenCalled();
  });

  it("keeps collapsing while the burst continues (ids added after the cap tripped)", async () => {
    const h = harness();

    for (let i = 0; i < MAX_DELTA_IDS + 5; i++) {
      h.queue.signal({ kind: "reaction", commentId: `spoofed-${i}` });
    }
    await settle();

    // full wins over whatever accumulated after the cap cleared the set
    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.fetchOne).not.toHaveBeenCalled();
  });
});
