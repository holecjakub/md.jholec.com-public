/**
 * Realtime delta queue for the comments state (perf C4/H9), extracted from
 * useComments so the debounce/verify/merge machinery is unit-testable.
 *
 * A broadcast signal names ONE comment. The doc channel is PUBLIC (the anon key
 * ships in the JS bundle, so any current or former participant can publish to
 * it) — therefore a signal is only ever a refetch HINT, never a state mutation.
 * Every kind, INCLUDING "delete", goes through the same debounced
 * fetch-and-verify path: the queue GETs just the named comment through the
 * session-authenticated, RLS-safe REST API and merges the response. A real
 * delete is confirmed by that GET returning 404 (null), which drops the row and
 * tombstones the id; a spoofed "delete" for a live comment merges the unchanged
 * row back — a no-op.
 *
 * Tombstones close the ghost race: a single-comment GET already in flight when
 * the row is deleted can resolve with the PRE-delete row after the local drop.
 * Once an id is tombstoned (server-confirmed 404, or the local DELETE 2xx via
 * useComments.removeComment) no flush ever merges it again.
 *
 * Fan-out cap: past `maxDeltaIds` distinct ids in one debounce window a single
 * full-list refetch is cheaper than N parallel single GETs — and it bounds the
 * request storm a burst of spoofed signals could otherwise trigger (N GETs ×
 * every connected viewer).
 *
 * A signal WITHOUT a payload ((re)connect/SUBSCRIBED, malformed broadcast) and
 * any delta-path failure degrade to the full-list refetch, which self-heals.
 */

import { dropComment, mergeComment, type CommentDTO } from "./comments-api";

export const REFETCH_DEBOUNCE_MS = 150;
export const MAX_DELTA_IDS = 10;

/** Structural subset of realtime's DocumentChangeSignal that the queue needs. */
export interface DeltaSignal {
  kind: string;
  commentId: string;
}

export interface DeltaQueueDeps {
  /** GET one enriched comment; null on 404 (deleted). */
  fetchOne: (id: string) => Promise<CommentDTO | null>;
  /** Full-list refetch (already self-guarding + structural-sharing). */
  refetchAll: () => Promise<void>;
  /** State installer — useComments passes setComments directly. */
  applyComments: (updater: (prev: CommentDTO[]) => CommentDTO[]) => void;
  /** Called after a successful delta flush (useComments clears its error). */
  clearError: () => void;
  /**
   * Server-confirmed deleted ids, shared with the owning hook so a local
   * DELETE can tombstone too. The queue adds every 404-confirmed id and never
   * merges a tombstoned row.
   */
  tombstones: Set<string>;
  debounceMs?: number;
  maxDeltaIds?: number;
}

export interface DeltaQueue {
  /** Feed one broadcast signal (undefined = state unknown → full refetch). */
  signal: (signal?: DeltaSignal) => void;
  /** Cancel any pending flush and ignore in-flight results (unmount/resubscribe). */
  dispose: () => void;
}

export function createDeltaQueue(deps: DeltaQueueDeps): DeltaQueue {
  const debounceMs = deps.debounceMs ?? REFETCH_DEBOUNCE_MS;
  const maxDeltaIds = deps.maxDeltaIds ?? MAX_DELTA_IDS;
  const pendingIds = new Set<string>();
  let pendingFull = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = async () => {
    const full = pendingFull;
    const ids = Array.from(pendingIds);
    pendingFull = false;
    pendingIds.clear();
    if (full || ids.length === 0) {
      await deps.refetchAll();
      return;
    }
    try {
      const fetched = await Promise.all(ids.map((id) => deps.fetchOne(id)));
      if (disposed) return;
      // A 404 means the comment vanished between the signal and the fetch —
      // the server-confirmed delete. Tombstone it BEFORE installing state so
      // no other in-flight GET (its updater reads the set at execution time)
      // can resurrect the row. Recorded outside the updater: React may replay
      // updaters, and side effects don't belong in them.
      for (let i = 0; i < ids.length; i++) {
        if (fetched[i] === null) deps.tombstones.add(ids[i]!);
      }
      deps.applyComments((prev) => {
        let next = prev;
        for (let i = 0; i < ids.length; i++) {
          const c = fetched[i];
          next =
            c && !deps.tombstones.has(c.id)
              ? mergeComment(next, c)
              : dropComment(next, ids[i]!);
        }
        return next;
      });
      deps.clearError();
    } catch {
      // Delta path failed (network, auth churn) — self-heal via the full list.
      await deps.refetchAll();
    }
  };

  const signal = (signal?: DeltaSignal) => {
    if (disposed) return;
    if (signal) {
      pendingIds.add(signal.commentId);
      if (pendingIds.size > maxDeltaIds) {
        // Fan-out cap — collapse the burst into ONE full-list refetch.
        pendingFull = true;
        pendingIds.clear();
      }
    } else {
      pendingFull = true;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, debounceMs);
  };

  const dispose = () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  };

  return { signal, dispose };
}
