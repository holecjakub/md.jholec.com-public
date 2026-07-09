import "server-only";
import { after } from "next/server";
import { admin } from "../db/admin";

/**
 * Server-side realtime broadcast for comment activity.
 *
 * Why broadcast and not postgres_changes: RLS is deny-by-default and browser
 * clients connect with the publishable/anon key, so they cannot observe table
 * changes. Broadcast is key-agnostic message passing that works regardless of
 * RLS. The server (this module, using the service-key admin client) emits a
 * minimal signal after each successful mutation; clients treat any signal as
 * "something changed" and refetch GET /comments (which is session-authenticated
 * and RLS-safe via the service key in the route).
 *
 * Security note: any session holder for the document can subscribe to
 * `doc:{documentId}` and will receive change *signals* (ids + timestamps only) —
 * never comment bodies, names, or reactions. Content always flows through the
 * authenticated REST GET. The signal only leaks that a comment changed, to
 * people who already have document access.
 */

export type BroadcastKind = "comment" | "reply" | "reaction" | "status" | "delete";

export interface BroadcastSignal {
  kind: BroadcastKind;
  commentId: string;
  at: string; // ISO timestamp
}

const CHANNEL_EVENT = "comments";

function channelName(documentId: string): string {
  return `doc:${documentId}`;
}

/**
 * Best-effort: broadcasts a change signal to the document's channel. Never
 * throws into the request path — failures are logged and swallowed so a
 * realtime hiccup can't fail a successful DB mutation.
 *
 * Transport: `httpSend` — a single REST POST to the realtime broadcast
 * endpoint (HTTP 202, no websocket). The old subscribe→send→removeChannel
 * dance paid a full websocket handshake (~150-450ms, up to 5s on timeout) per
 * signal; REST needs no subscription at all (perf H8). We still remove the
 * channel afterwards so the module-level admin client doesn't accumulate
 * unjoined channel objects across invocations.
 */
export async function broadcastDocumentChange(
  documentId: string,
  signal: Omit<BroadcastSignal, "at"> & { at?: string },
): Promise<void> {
  const client = admin();
  const channel = client.channel(channelName(documentId), {
    config: { broadcast: { ack: false, self: false } },
  });
  try {
    const payload: BroadcastSignal = {
      kind: signal.kind,
      commentId: signal.commentId,
      at: signal.at ?? new Date().toISOString(),
    };
    const result = await channel.httpSend(CHANNEL_EVENT, payload);
    if (!result.success) {
      console.error(
        "[realtime] broadcastDocumentChange failed",
        `HTTP ${result.status}: ${result.error}`,
      );
    }
  } catch (err) {
    console.error("[realtime] broadcastDocumentChange failed", err);
  } finally {
    try {
      await client.removeChannel(channel);
    } catch {
      // ignore cleanup failures
    }
  }
}

/**
 * Schedules the broadcast to run AFTER the mutation response has been sent
 * (Next `after()`), so the realtime round-trip never sits on the write's
 * response path (perf H8). The signal timestamp is stamped now — at mutation
 * time — not when the deferred callback eventually runs. Route handlers call
 * this instead of awaiting `broadcastDocumentChange` directly.
 */
export function scheduleDocumentChangeBroadcast(
  documentId: string,
  signal: Omit<BroadcastSignal, "at">,
): void {
  const at = new Date().toISOString();
  after(() => broadcastDocumentChange(documentId, { ...signal, at }));
}
