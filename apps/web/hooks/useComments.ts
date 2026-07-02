"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuoteAnchor } from "@md/core";
import {
  buildThreads,
  deleteComment,
  fetchComments,
  patchStatus,
  postComment,
  postReaction,
  postReply,
  type CommentDTO,
  type CommentStatus,
  type CommentThread,
} from "@/lib/comments-api";
import { subscribeToDocument } from "@/lib/realtime";
import { useToast } from "@/components/ui/toast";

const REFETCH_DEBOUNCE_MS = 150;

interface UseCommentsResult {
  comments: CommentDTO[];
  threads: CommentThread[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  addComment: (anchor: TextQuoteAnchor, body: string, authorName?: string) => Promise<void>;
  addReply: (commentId: string, body: string) => Promise<void>;
  react: (commentId: string, emoji: string) => Promise<void>;
  setStatus: (commentId: string, status: CommentStatus) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
}

/**
 * Owns comment state for one document: initial fetch, a thread tree, optimistic
 * mutations, and the realtime subscription (signal → debounced refetch). Local
 * mutations refetch immediately after the server confirms, and the broadcast
 * keeps OTHER clients in sync. State updates only ever run after an awaited
 * network call — never synchronously inside an effect.
 */
export function useComments(slug: string, documentId: string): UseCommentsResult {
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guard against applying responses after unmount.
  const aliveRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const next = await fetchComments(slug);
      if (aliveRef.current) {
        setComments(next);
        setError(null);
      }
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
  // React 19 "no synchronous setState in effect" rule.
  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      await refetch();
      if (aliveRef.current) setLoading(false);
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [refetch]);

  // Realtime: debounce a burst of signals into a single refetch.
  useEffect(() => {
    const onSignal = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void refetch();
      }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeToDocument(documentId, onSignal);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unsubscribe();
    };
  }, [documentId, refetch]);

  const addComment = useCallback(
    (anchor: TextQuoteAnchor, body: string, authorName?: string) =>
      runWithRetry("Couldn’t post your comment.", async () => {
        // INSTANT optimistic insert: a client-generated UUID is the comment's real id —
        // sent to the server so it persists with the SAME id. That stability is what makes
        // this safe: the badge + underline appear on the very click, and when the server
        // row reconciles there is no temp→real id swap (which previously churned the
        // inline-highlight rebuild and broke badge↔underline hover coupling). The viewer's
        // name gives the correct identity colour + initials immediately — no "You" flicker.
        const id =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
        if (aliveRef.current) setComments((prev) => [...prev, optimistic]);

        let created: CommentDTO;
        try {
          created = await postComment(slug, anchor, body, id);
        } catch (err) {
          if (aliveRef.current) setComments((prev) => prev.filter((c) => c.id !== id));
          throw err;
        }

        // Reconcile fields in place (same id, author + status unchanged → the highlight
        // layer skips a rebuild, so a mid-hover emphasis survives).
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
        await refetch();
      }),
    [slug, documentId, refetch, runWithRetry],
  );

  const addReply = useCallback(
    (commentId: string, body: string) =>
      runWithRetry("Couldn’t post your reply.", async () => {
        const created = await postReply(slug, commentId, body);
        if (aliveRef.current) {
          setComments((prev) =>
            prev.some((c) => c.id === created.id)
              ? prev
              : [...prev, { ...created, author_name: created.author_name ?? "You", reactions: [] }],
          );
        }
        await refetch();
      }),
    [slug, refetch, runWithRetry],
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
          await refetch();
          throw err;
        }
        // Reconcile against the source of truth.
        await refetch();
      }),
    [slug, refetch, runWithRetry],
  );

  const setStatus = useCallback(
    (commentId: string, status: CommentStatus) =>
      runWithRetry("Couldn’t update the comment.", async () => {
        const updated = await patchStatus(slug, commentId, status);
        if (aliveRef.current) {
          setComments((prev) => prev.map((c) => (c.id === updated.id ? { ...c, status: updated.status } : c)));
        }
        await refetch();
      }),
    [slug, refetch, runWithRetry],
  );

  const removeComment = useCallback(
    (commentId: string) =>
      runWithRetry("Couldn’t delete the comment.", async () => {
        await deleteComment(slug, commentId);
        // Optimistic removal: drop the comment and — if it was a root — its replies,
        // before the broadcast/refetch reconciles the single source of truth.
        if (aliveRef.current) {
          setComments((prev) =>
            prev.filter((c) => c.id !== commentId && c.parent_id !== commentId),
          );
        }
        await refetch();
      }),
    [slug, refetch, runWithRetry],
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
