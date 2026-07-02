"use client";

import { supabaseBrowser } from "./supabase-browser";

/**
 * Subscribe to a document's realtime broadcast channel (`doc:{documentId}`).
 *
 * Signal-then-refetch: the server broadcasts a minimal "something changed"
 * signal after each mutation (no comment bodies on the wire). The client treats
 * any signal — and every (re)subscribe — as a cue to refetch GET /comments,
 * which is session-authenticated and RLS-safe. Refetching on SUBSCRIBED makes a
 * client that was briefly offline catch up on reconnect.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToDocument(
  documentId: string,
  onSignal: () => void,
): () => void {
  const supabase = supabaseBrowser();
  const channel = supabase.channel(`doc:${documentId}`, {
    config: { broadcast: { self: false } },
  });

  channel
    .on("broadcast", { event: "comments" }, () => {
      onSignal();
    })
    .subscribe((status) => {
      // Initial join AND any automatic reconnect surface as SUBSCRIBED → catch up.
      if (status === "SUBSCRIBED") onSignal();
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
