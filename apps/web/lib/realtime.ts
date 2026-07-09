"use client";

import { supabaseBrowser } from "./supabase-browser";

/** Client-side mirror of the server's BroadcastSignal (lib/realtime/broadcast.ts). */
export type DocumentChangeKind = "comment" | "reply" | "reaction" | "status" | "delete";

export interface DocumentChangeSignal {
  kind: DocumentChangeKind;
  commentId: string;
  at: string; // ISO timestamp
}

const KINDS: readonly string[] = ["comment", "reply", "reaction", "status", "delete"];

/** Narrow an arbitrary broadcast payload to a well-formed signal (else undefined). */
function parseSignal(payload: unknown): DocumentChangeSignal | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.kind !== "string" || !KINDS.includes(p.kind)) return undefined;
  if (typeof p.commentId !== "string" || p.commentId.length === 0) return undefined;
  return {
    kind: p.kind as DocumentChangeKind,
    commentId: p.commentId,
    at: typeof p.at === "string" ? p.at : new Date().toISOString(),
  };
}

/**
 * Subscribe to a document's realtime broadcast channel (`doc:{documentId}`).
 *
 * Signal-then-delta-refetch: the server broadcasts a minimal signal after each
 * mutation ({kind, commentId, at} — no comment bodies on the wire). The client
 * uses it to fetch just the ONE changed comment (or drop it locally on delete)
 * via the session-authenticated, RLS-safe REST API (perf C4/H9). A (re)subscribe
 * — including every automatic reconnect — calls `onSignal` with NO signal,
 * which callers treat as "state unknown, refetch the full list" so a client
 * that was briefly offline catches up. A malformed payload degrades the same
 * way (undefined → full refetch).
 *
 * Returns an unsubscribe function.
 */
export function subscribeToDocument(
  documentId: string,
  onSignal: (signal?: DocumentChangeSignal) => void,
): () => void {
  const supabase = supabaseBrowser();
  const channel = supabase.channel(`doc:${documentId}`, {
    config: { broadcast: { self: false } },
  });

  channel
    .on("broadcast", { event: "comments" }, (message) => {
      onSignal(parseSignal((message as { payload?: unknown }).payload));
    })
    .subscribe((status) => {
      // Initial join AND any automatic reconnect surface as SUBSCRIBED → catch up
      // with a FULL refetch (no signal argument).
      if (status === "SUBSCRIBED") onSignal();
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
