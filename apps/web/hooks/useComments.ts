"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuoteAnchor } from "@md/core";
import {
  buildThreads,
  deleteComment,
  dropComment,
  fetchComment,
  fetchComments,
  mergeComment,
  patchStatus,
  postComment,
  postReaction,
  postReply,
  reconcileWithPending,
  type CommentDTO,
  type CommentStatus,
  type CommentThreadDTO,
} from "@/lib/comments-api";
import { createDeltaQueue } from "@/lib/comments-delta";
import { subscribeToDocument } from "@/lib/realtime";
import { useToast } from "@/components/ui/toast";

// Periodic self-healing full refetch: catches anything a lost broadcast or a
// failed delta left behind. Unchanged state costs a 304 with no body (perf M2)
// and no render (reconcile returns the previous reference).
const SAFETY_REFETCH_MS = 60_000;

interface UseCommentsResult {
  comments: CommentDTO[];
  threads: CommentThreadDTO[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /**
   * Posts a comment. Resolves with the comment's (client-minted, server-kept)
   * id once the POST has succeeded, or null when it failed — the id is what
   * lets a caller offer Undo (delete) for a just-posted comment, e.g. the
   * one-tap emoji quick-react. A toast-Retry re-run resolves separately; the
   * original promise has already settled by then.
   */
  addComment: (
    anchor: TextQuoteAnchor,
    body: string,
    authorName?: string,
  ) => Promise<string | null>;
  addReply: (commentId: string, body: string) => Promise<void>;
  react: (commentId: string, emoji: string) => Promise<void>;
  setStatus: (commentId: string, status: CommentStatus) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
}

/**
 * Owns comment state for one document: initial state, a thread tree, optimistic
 * mutations, and the realtime subscription. Local mutations apply optimistically
 * and reconcile in place from the server response — no trailing full refetch
 * (perf C4). Realtime signals from OTHER clients merge as deltas: every kind —
 * INCLUDING delete, since the public broadcast channel is untrusted input —
 * fetches just the ONE changed comment and reconciles from the authenticated
 * response (perf C4/H9; a 404 is the server-confirmed delete). Full-list
 * refetches remain only where they self-heal: (re)connect/SUBSCRIBED, the
 * periodic safety interval, a burst past the delta fan-out cap, and any
 * delta-path failure. All state installs go through structural-sharing
 * reconciliation (perf C3) so unchanged rows/threads keep their identities.
 * State updates only ever run after an awaited network call — never
 * synchronously inside an effect.
 *
 * When `initialComments` is provided (the document payload embeds the list —
 * perf H1), the state is seeded from it and the redundant initial GET is
 * skipped entirely: the first paint needs no second sequential round trip.
 */
export function useComments(
  slug: string,
  documentId: string,
  initialComments?: CommentDTO[],
): UseCommentsResult {
  const [comments, setComments] = useState<CommentDTO[]>(initialComments ?? []);
  const [loading, setLoading] = useState(initialComments === undefined);
  const [error, setError] = useState<string | null>(null);

  // Guard against applying responses after unmount.
  const aliveRef = useRef(true);
  // Server-confirmed deleted comment ids (tombstones). A single-comment GET
  // already in flight when the row is deleted can resolve with the PRE-delete
  // row after the local drop; without this set the delta flush would merge that
  // ghost back for up to SAFETY_REFETCH_MS. Ids are stamped only on server
  // confirmation (local DELETE 2xx, or a delta GET 404) — never straight from a
  // broadcast payload, which is untrusted. UUIDs never recur, so the set only
  // grows by actual deletions in this session.
  const deletedIdsRef = useRef<Set<string>>(new Set());
  // Ids of locally created rows that no full-list response has confirmed yet
  // (audit 1.5). A full refetch is a snapshot taken when its REQUEST started,
  // so one that was already in flight when the user commented resolves WITHOUT
  // the new row — reconciling it plainly would wipe the optimistic comment.
  // Pending rows are merged back into every full-list install until a response
  // finally contains them (then the snapshot provably post-dates the create).
  // Removed on rollback (failed POST) and on delete (tombstone also blocks the
  // merge-back), so the set cannot pin a row that should be gone.
  const pendingCreatesRef = useRef<Set<string>>(new Set());
  // Monotonic refetch sequence (audit 1.5): overlapping full refetches (safety
  // tick + reconnect + delta-failure fallback) can resolve out of order, and an
  // older snapshot must never overwrite a newer one — only the LATEST issued
  // request may install state or advance the ETag.
  const fetchSeqRef = useRef(0);
  // True until the seeded first mount has consumed its skip (see initial-load
  // effect below). Never true when the caller did not seed.
  const seededRef = useRef(initialComments !== undefined);
  // Last comments ETag, echoed as If-None-Match so an unchanged reconnect refetch
  // returns 304 with an empty body (perf M2). The seeded initial state has no
  // ETag, so the first real refetch is a full 200 that establishes it.
  const etagRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    try {
      const res = await fetchComments(slug, etagRef.current);
      // Apply only the LATEST issued refetch (audit 1.5): a slower, earlier
      // request resolving after a newer one carries a staler snapshot (and a
      // staler validator) — installing it would roll live state backwards.
      if (!aliveRef.current || seq !== fetchSeqRef.current) return;
      etagRef.current = res.etag;
      if (res.notModified) {
        // Nothing changed on the server — skip setComments entirely (this is the
        // cheapest form of the A-BAILOUT guard: no body parsed, no compare, no
        // downstream buildThreads/highlight rebuild).
        setError(null);
        return;
      }
      const next = res.comments ?? [];
      // A pending create observed in a full-list response is durable in every
      // later snapshot too — unpin it (see pendingCreatesRef).
      const pending = pendingCreatesRef.current;
      if (pending.size > 0) {
        for (const c of next) pending.delete(c.id);
      }
      // Structural-sharing reconcile (perf C3, 200 path): rows whose signature
      // is unchanged KEEP their previous object reference, and a fully unchanged
      // list returns the previous ARRAY reference — React skips the render and
      // the downstream buildThreads/highlight rebuild cascade never runs for a
      // no-op (subsumes the A-BAILOUT sameComments check). Genuine deltas swap
      // only the changed rows, so downstream memo boundaries stay warm. Rows
      // still pending (created after this snapshot's request started) are merged
      // back so a stale full list can't wipe an optimistic insert (audit 1.5).
      setComments((prev) => reconcileWithPending(prev, next, pending, deletedIdsRef.current));
      setError(null);
    } catch (err) {
      if (aliveRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load comments");
      }
    }
  }, [slug]);

  const { toast } = useToast();

  // Run a mutation; if it throws, surface a toast with a Retry that re-runs it.
  // Mutations do their own optimistic insert + rollback, then rethrow on failure so
  // this single place owns the user-facing failure feedback (previously silent).
  // Holds the latest runWithRetry so a Retry click re-runs the current wrapper.
  // Declared before runWithRetry (no forward ref) and synced in an effect (never
  // written during render) to satisfy the react-hooks immutability rules.
  const retryRef = useRef<(message: string, run: () => Promise<void>) => Promise<void>>(
    async () => {},
  );
  const runWithRetry = useCallback(
    async (message: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch {
        toast({
          tone: "error",
          message,
          action: { label: "Retry", onClick: () => void retryRef.current(message, run) },
        });
      }
    },
    [toast],
  );
  useEffect(() => {
    retryRef.current = runWithRetry;
  }, [runWithRetry]);

  // Initial load. The setState runs after the awaited fetch, satisfying the
  // React 19 "no synchronous setState in effect" rule. A seeded mount skips the
  // fetch once — the embedded list IS the initial state — but only once, so a
  // later re-run (slug change → new refetch identity) still fetches for real.
  useEffect(() => {
    aliveRef.current = true;
    if (seededRef.current) {
      seededRef.current = false;
    } else {
      void (async () => {
        await refetch();
        if (aliveRef.current) setLoading(false);
      })();
    }
    return () => {
      aliveRef.current = false;
    };
  }, [refetch]);

  // Realtime: delta-first (perf C4/H9) via the extracted, unit-tested queue
  // (lib/comments-delta.ts). A payload signal names ONE comment; the queue
  // debounces a burst into one flush that GETs just those comments and merges
  // them with structural sharing. The public broadcast channel is untrusted, so
  // EVERY kind — including "delete" — is fetch-and-verify: a real delete is the
  // GET's 404 (dropped + tombstoned), a spoofed one is a no-op merge. A signal
  // WITHOUT a payload ((re)connect/SUBSCRIBED, malformed broadcast), a burst
  // past the fan-out cap, and any delta failure degrade to a full refetch so a
  // briefly offline (or attacked) client self-heals.
  useEffect(() => {
    const queue = createDeltaQueue({
      fetchOne: (id) => fetchComment(slug, id),
      refetchAll: refetch,
      applyComments: setComments,
      clearError: () => setError(null),
      tombstones: deletedIdsRef.current,
    });
    const unsubscribe = subscribeToDocument(documentId, queue.signal);
    return () => {
      queue.dispose();
      unsubscribe();
    };
  }, [documentId, slug, refetch]);

  // Periodic safety refetch (self-healing). Conditional GET: the unchanged case
  // is a 304 with an empty body, and even a 200 that reconciles to the same
  // state produces no render (reconcileComments returns prev).
  useEffect(() => {
    const timer = setInterval(() => {
      void refetch();
    }, SAFETY_REFETCH_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  const addComment = useCallback(
    (anchor: TextQuoteAnchor, body: string, authorName?: string) => {
      // The client-generated UUID is the comment's real id — sent to the server so
      // it persists with the SAME id. That stability is what makes the optimistic
      // insert safe: the badge + underline appear on the very click, and when the
      // server row reconciles there is no temp→real id swap (which previously
      // churned the inline-highlight rebuild and broke badge↔underline hover
      // coupling). Minted ONCE per user action, OUTSIDE the retryable closure
      // (audit 1.6): a toast Retry re-runs the closure, and an id minted inside it
      // would post a brand-new comment on every attempt — a duplicate whenever the
      // first POST actually landed. With a stable id the server replays the
      // already-persisted row instead (23505 → idempotent response).
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // True once THIS invocation's POST landed — the returned id is only
      // meaningful (usable for Undo/delete) when the row actually persisted.
      let posted = false;
      return runWithRetry("Couldn’t post your comment.", async () => {
        // INSTANT optimistic insert (see the id above for why it's stable). The
        // viewer's name gives the correct identity colour + initials immediately —
        // no "You" flicker.
        const optimistic: CommentDTO = {
          id,
          document_id: documentId,
          version_id: "",
          participant_id: "",
          anchor,
          body,
          parent_id: null,
          status: "open",
          created_at: new Date().toISOString(),
          author_name: authorName ?? "You",
          reactions: [],
        };
        // Pin the row against stale full-list snapshots until one includes it
        // (audit 1.5) — pinned BEFORE the insert so no refetch can win the race.
        pendingCreatesRef.current.add(id);
        // Guarded insert: on a Retry whose FIRST attempt actually persisted
        // (response lost), a delta/refetch may have merged the server row back
        // already — the same id must never appear twice in the list.
        if (aliveRef.current) {
          setComments((prev) => (prev.some((c) => c.id === id) ? prev : [...prev, optimistic]));
        }

        let created: CommentDTO;
        try {
          created = await postComment(slug, anchor, body, id);
          posted = true;
        } catch (err) {
          pendingCreatesRef.current.delete(id);
          if (aliveRef.current) setComments((prev) => prev.filter((c) => c.id !== id));
          throw err;
        }

        // Reconcile fields in place (same id, author + status unchanged → the highlight
        // layer skips a rebuild, so a mid-hover emphasis survives). No trailing full
        // refetch (perf C4): the POST response IS the server truth for this row, and
        // the reconciled object's identity persists through later refetches because
        // its signature now matches the server's (invariant L5-1).
        if (aliveRef.current) {
          setComments((prev) =>
            prev.map((c) =>
              c.id === id
                ? {
                    ...c,
                    ...created,
                    author_name: created.author_name ?? authorName ?? "You",
                    reactions: created.reactions ?? c.reactions,
                  }
                : c,
            ),
          );
        }
      }).then(() => (posted ? id : null));
    },
    [slug, documentId, runWithRetry],
  );

  const addReply = useCallback(
    (commentId: string, body: string) =>
      runWithRetry("Couldn’t post your reply.", async () => {
        const created = await postReply(slug, commentId, body);
        // Pin against stale full-list snapshots, same as addComment (audit 1.5):
        // a full refetch already in flight when this POST landed misses the row.
        pendingCreatesRef.current.add(created.id);
        // The POST response is the server truth for the new reply — no trailing
        // full refetch (perf C4). Replies live in the same flat list.
        if (aliveRef.current) {
          setComments((prev) =>
            prev.some((c) => c.id === created.id)
              ? prev
              : [...prev, { ...created, author_name: created.author_name ?? "You", reactions: [] }],
          );
        }
      }),
    [slug, runWithRetry],
  );

  const react = useCallback(
    (commentId: string, emoji: string) =>
      runWithRetry("Couldn’t save your reaction.", async () => {
        // Optimistic toggle: flip the viewer's reaction locally so the pill responds
        // on the very tap, then reconcile with the server. Without this the UI sat
        // still through two round-trips (POST + refetch) and felt broken.
        if (aliveRef.current) {
          setComments((prev) =>
            prev.map((c) => {
              if (c.id !== commentId) return c;
              const groups = c.reactions.map((g) => ({ ...g }));
              const idx = groups.findIndex((g) => g.emoji === emoji);
              const existing = idx === -1 ? undefined : groups[idx];
              if (!existing) {
                groups.push({ emoji, count: 1, mine: true });
              } else if (existing.mine) {
                const count = existing.count - 1;
                if (count <= 0) groups.splice(idx, 1);
                else groups[idx] = { ...existing, count, mine: false };
              } else {
                groups[idx] = { ...existing, count: existing.count + 1, mine: true };
              }
              return { ...c, reactions: groups };
            }),
          );
        }
        try {
          await postReaction(slug, commentId, emoji);
        } catch (err) {
          // Revert the optimistic flip, then rethrow so the failure toast shows.
          // Drop the stored validator first: a failed POST (e.g. 429) can leave
          // server state UNCHANGED, so a conditional refetch would 304 and skip
          // setComments — the phantom reaction would stick. Forcing a full 200
          // guarantees the revert actually lands.
          etagRef.current = null;
          await refetch();
          throw err;
        }
        // Reconcile against the source of truth — just this ONE comment (perf
        // C4/H9): POST /react returns no body, so fetch the enriched row and
        // merge it. mergeComment keeps the previous reference when the optimistic
        // flip already matches; a 404 means the comment was deleted meanwhile.
        const confirmed = await fetchComment(slug, commentId);
        // 404 = server-confirmed delete → tombstone (see deletedIdsRef); and a
        // row that resolves AFTER its tombstone was stamped is stale — drop it.
        if (!confirmed) deletedIdsRef.current.add(commentId);
        if (aliveRef.current) {
          setComments((prev) =>
            confirmed && !deletedIdsRef.current.has(confirmed.id)
              ? mergeComment(prev, confirmed)
              : dropComment(prev, commentId),
          );
        }
      }),
    [slug, refetch, runWithRetry],
  );

  const setStatus = useCallback(
    (commentId: string, status: CommentStatus) =>
      runWithRetry("Couldn’t update the comment.", async () => {
        const updated = await patchStatus(slug, commentId, status);
        // In-place status merge from the PATCH response — no trailing full
        // refetch (perf C4). Only the touched row gets a new identity.
        if (aliveRef.current) {
          setComments((prev) => prev.map((c) => (c.id === updated.id ? { ...c, status: updated.status } : c)));
        }
      }),
    [slug, runWithRetry],
  );

  const removeComment = useCallback(
    (commentId: string) =>
      runWithRetry("Couldn’t delete the comment.", async () => {
        await deleteComment(slug, commentId);
        // Server-confirmed: tombstone the id so a delta GET that raced the
        // DELETE can never merge the stale pre-delete row back (ghost race).
        deletedIdsRef.current.add(commentId);
        // A deleted row must not stay pinned as a pending create either.
        pendingCreatesRef.current.delete(commentId);
        // Drop the comment and — if it was a root — its replies. The DELETE
        // response confirms the removal, so no trailing full refetch (perf C4).
        if (aliveRef.current) {
          setComments((prev) => dropComment(prev, commentId));
        }
      }),
    [slug, runWithRetry],
  );

  const threads = useMemo(() => buildThreads(comments), [comments]);

  return {
    comments,
    threads,
    loading,
    error,
    refetch,
    addComment,
    addReply,
    react,
    setStatus,
    removeComment,
  };
}
