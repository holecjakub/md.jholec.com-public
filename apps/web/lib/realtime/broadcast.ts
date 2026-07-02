import "server-only";
import type { RealtimeChannel } from "@supabase/supabase-js";
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
const SUBSCRIBE_TIMEOUT_MS = 5000;

function channelName(documentId: string): string {
  return `doc:${documentId}`;
}

async function subscribe(channel: RealtimeChannel): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscribe timed out")), SUBSCRIBE_TIMEOUT_MS);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        reject(new Error(`Realtime channel status: ${status}`));
      }
    });
  });
}

/**
 * Best-effort: broadcasts a change signal to the document's channel. Never
 * throws into the request path — failures are logged and swallowed so a
 * realtime hiccup can't fail a successful DB mutation.
 *
 * Serverless model: we deliberately do NOT cache channels across requests. On
 * Vercel a module-level Map of subscribed channels would leak across invocations
 * (and across documents) and never be torn down, exhausting the realtime
 * connection. Instead we subscribe, send, then remove the channel each time. The
 * extra subscribe round-trip costs some latency, but the signal is a tiny
 * fire-and-forget payload and clients only treat it as "refetch now".
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
    await subscribe(channel);
    const payload: BroadcastSignal = {
      kind: signal.kind,
      commentId: signal.commentId,
      at: signal.at ?? new Date().toISOString(),
    };
    await channel.send({ type: "broadcast", event: CHANNEL_EVENT, payload });
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
