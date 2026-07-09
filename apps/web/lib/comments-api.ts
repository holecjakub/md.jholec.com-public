/**
 * Typed client for the commenting endpoints (Plan 04). Mirrors the server
 * contracts in app/api/d/[slug]/comments/* and /share. All calls are
 * same-origin and rely on the httpOnly md_session cookie for auth.
 */

import type { TextQuoteAnchor } from "@md/core";
import type { Role } from "./document-api";
import { readErrorMessage } from "./error-message";

export type CommentStatus = "open" | "resolved";

export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

/**
 * A comment row as returned by GET /comments (enriched with author + reactions).
 *
 * NAMING: this is the wire/DTO shape — snake_case fields (`document_id`,
 * `parent_id`, …) plus `reactions`. Do NOT confuse it with the core `Comment`
 * type (`@md/core`), which is a camelCase, reaction-less domain type. The `DTO`
 * suffix here (and on `CommentThreadDTO`) exists precisely so an autocompleted
 * import of core `Comment` can never silently masquerade as this shape.
 */
export interface CommentDTO {
  id: string;
  document_id: string;
  version_id: string;
  participant_id: string;
  anchor: TextQuoteAnchor;
  body: string;
  parent_id: string | null;
  status: CommentStatus;
  created_at: string;
  author_name: string;
  reactions: ReactionGroup[];
}

export interface CommentsResponse {
  comments: CommentDTO[];
}

/**
 * A top-level comment with its replies, assembled client-side from the flat
 * list. DTO-suffixed for the same reason as `CommentDTO`: it holds wire-shaped
 * `CommentDTO`s and must not be mistaken for any core domain type.
 */
export interface CommentThreadDTO {
  root: CommentDTO;
  replies: CommentDTO[];
}

class CommentsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CommentsApiError";
    this.status = status;
  }
}

function base(slug: string): string {
  return `/api/d/${encodeURIComponent(slug)}`;
}

async function readError(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    message = readErrorMessage(await res.json(), fallback);
  } catch {
    // keep fallback
  }
  throw new CommentsApiError(res.status, message);
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await readError(res, fallback);
  return (await res.json()) as T;
}

/**
 * Result of a conditional comments fetch. On 304 (`notModified`) the server sent
 * an empty body and `comments` is null — the caller must keep its current state.
 * `etag` is the validator to echo back on the next request (null when the server
 * sent none).
 */
export interface CommentsFetchResult {
  comments: CommentDTO[] | null;
  etag: string | null;
  notModified: boolean;
}

export async function fetchComments(
  slug: string,
  etag?: string | null,
): Promise<CommentsFetchResult> {
  const res = await fetch(`${base(slug)}/comments`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    // Conditional GET: on an unchanged reconnect the server answers 304 with an
    // empty body (perf M2). We manage the validator ourselves rather than leaning
    // on the browser HTTP cache, hence cache:"no-store" stays.
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  if (res.status === 304) {
    return { comments: null, etag: etag ?? null, notModified: true };
  }
  if (!res.ok) await readError(res, "Failed to load comments");
  const data = (await res.json()) as CommentsResponse;
  return { comments: data.comments, etag: res.headers.get("ETag"), notModified: false };
}

/**
 * Fetch ONE enriched comment (delta refetch, perf C4/H9). A realtime signal
 * names a single commentId; fetching just that row replaces refetching the
 * whole list. Returns null on 404 — the comment was deleted between the signal
 * and the fetch, which callers treat as a delete.
 */
export async function fetchComment(slug: string, commentId: string): Promise<CommentDTO | null> {
  const res = await fetch(`${base(slug)}/comments/${encodeURIComponent(commentId)}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) await readError(res, "Failed to load comment");
  const data = (await res.json()) as { comment: CommentDTO };
  return data.comment;
}

export async function postComment(
  slug: string,
  anchor: TextQuoteAnchor,
  body: string,
  id?: string,
): Promise<CommentDTO> {
  const data = await postJson<{ comment: CommentDTO }>(
    `${base(slug)}/comments`,
    id ? { anchor, body, id } : { anchor, body },
    "Failed to post comment",
  );
  return data.comment;
}

export async function postReply(
  slug: string,
  commentId: string,
  body: string,
): Promise<CommentDTO> {
  const data = await postJson<{ comment: CommentDTO }>(
    `${base(slug)}/comments/${encodeURIComponent(commentId)}/reply`,
    { body },
    "Failed to post reply",
  );
  return data.comment;
}

export async function postReaction(
  slug: string,
  commentId: string,
  emoji: string,
): Promise<void> {
  await postJson<unknown>(
    `${base(slug)}/comments/${encodeURIComponent(commentId)}/react`,
    { emoji },
    "Failed to react",
  );
}

export async function patchStatus(
  slug: string,
  commentId: string,
  status: CommentStatus,
): Promise<CommentDTO> {
  const res = await fetch(`${base(slug)}/comments/${encodeURIComponent(commentId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) await readError(res, "Failed to update comment");
  const data = (await res.json()) as { comment: CommentDTO };
  return data.comment;
}

export async function deleteComment(slug: string, commentId: string): Promise<void> {
  const res = await fetch(`${base(slug)}/comments/${encodeURIComponent(commentId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, "Failed to delete comment");
}

/**
 * Fetch the document's full Markdown text including embedded comments, exactly
 * as the Download button produces. Uses the same GET /api/d/[slug]/download
 * endpoint — owner session cookie required.
 *
 * Returns the raw .md string so callers can write it to the clipboard or
 * process it further without creating a file download.
 */
export async function fetchDocumentMarkdown(slug: string): Promise<string> {
  const res = await fetch(`${base(slug)}/download`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, "Failed to fetch document");
  return res.text();
}

export async function createShareLink(slug: string): Promise<string> {
  const data = await postJson<{ shareUrl: string }>(
    `${base(slug)}/share`,
    {},
    "Failed to create share link",
  );
  return data.shareUrl;
}

/**
 * Revoke EVERY live reusable reviewer (invite) link for the document (audit
 * M5). DELETE /share stamps `revoked_at` on all live invite tokens server-side
 * — previously shared URLs stop redeeming immediately. Owner-authority only;
 * returns how many links were revoked.
 */
export async function revokeShareLinks(slug: string): Promise<number> {
  const res = await fetch(`${base(slug)}/share`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, "Failed to revoke reviewer links");
  const data = (await res.json()) as { revoked: number };
  return data.revoked;
}

/**
 * Mint a read-only export PAT (kind = "export") and return the agent capability
 * URL in the form `<origin>/d/<slug>/agent/<token>`.
 *
 * This is a GET capability URL: fetching it returns a static HTML page with the
 * document + visible comments, so it works when pasted into a generic LLM
 * (ChatGPT etc.) that just fetches the link. The read-only token is in the path
 * (acceptable: it is read-only, single-document, 30-day, and revocable).
 *
 * Owner session cookie is required; call only from owner surfaces.
 * The token is shown once — do not call twice without revoking first.
 */
export async function createAgentLink(slug: string): Promise<string> {
  const data = await postJson<{ token: string }>(
    `${base(slug)}/pat`,
    { name: "AI agent (read-only)", kind: "export" },
    "Failed to create agent link",
  );
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/d/${encodeURIComponent(slug)}/agent/${data.token}`;
}

/**
 * Cheap structural signature of one comment: the fields whose change must
 * repaint the UI (identity, thread linkage, status, body, and the aggregated
 * reaction state). `created_at` stands in for a mutation timestamp — the DB has
 * an `updated_at` column, but the CommentDTO doesn't expose it, and body/status/
 * reactions are the only mutable fields, all covered explicitly here. Fields are
 * NUL-delimited so no crafted body can collide with another field's boundary.
 * Reactions are folded into a stable, order-free string so a re-fetch that
 * returns the same groups in a different order still compares equal.
 */
function commentSignature(c: CommentDTO): string {
  const reactions = c.reactions
    .map((r) => `${r.emoji}:${r.count}:${r.mine ? 1 : 0}`)
    .sort()
    .join(",");
  return `${c.id}\u0000${c.parent_id ?? ""}\u0000${c.status}\u0000${c.created_at}\u0000${c.body}\u0000${reactions}`;
}

/**
 * True when two comment lists are structurally identical (same comments, same
 * order, same per-comment signature). Lets callers bail out of a no-op state
 * update — realtime SUBSCRIBED/reconnect signals and every mutation's trailing
 * refetch routinely re-deliver byte-identical data, and skipping those keeps the
 * downstream thread/highlight rebuild cascade from running for nothing. Reply
 * add/remove is caught because replies live in this same flat list, so the
 * length (or element signature) changes.
 */
export function sameComments(a: CommentDTO[], b: CommentDTO[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    // Lengths are equal (checked above), so both indexes are in bounds.
    if (commentSignature(a[i]!) !== commentSignature(b[i]!)) return false;
  }
  return true;
}

/**
 * Reconcile a freshly fetched list against the current state with STRUCTURAL
 * SHARING (perf C3): every incoming row whose signature matches the row we
 * already hold keeps the PREVIOUS object reference, so downstream memo
 * boundaries (per-thread cards, highlight spans) see identical props and skip.
 * Only genuinely changed rows get the new server object; a fully unchanged
 * list returns `prev` itself (the A-BAILOUT no-op signal — React skips the
 * render entirely).
 *
 * Identity invariant (audit L5-1): the reconciled optimistic object (client
 * UUID = real id) survives every trailing refetch — the server row has the
 * same id and signature, so the local object is reused, never replaced by a
 * server-shaped clone.
 */
export function reconcileComments(prev: CommentDTO[], next: CommentDTO[]): CommentDTO[] {
  if (prev === next) return prev;
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const merged = next.map((c) => {
    const old = prevById.get(c.id);
    return old && commentSignature(old) === commentSignature(c) ? old : c;
  });
  // Same length + same object at every position ⇒ the list is a no-op; hand
  // back the previous ARRAY reference too so setState/useMemo bail out.
  if (merged.length === prev.length && merged.every((c, i) => c === prev[i])) return prev;
  return merged;
}

/**
 * Full-list reconcile that cannot clobber local pending creates (audit 1.5).
 *
 * A full refetch (60s safety tick, reconnect, delta-failure fallback) races
 * local optimistic inserts: the response is a snapshot taken when the REQUEST
 * started, so a comment created after that moment is missing from `next`, and
 * a plain `reconcileComments` would wipe the optimistic row until the next
 * refetch. Every row in `prev` whose id is still pending (created locally,
 * not yet observed in any full-list response) is merged back — unless it was
 * tombstoned (server-confirmed delete) meanwhile. Merge-back goes through
 * `mergeComment`, so the row lands in `created_at` order and identities are
 * preserved. Read-only on both sets; callers own their lifecycle.
 */
export function reconcileWithPending(
  prev: CommentDTO[],
  next: CommentDTO[],
  pendingCreateIds: ReadonlySet<string>,
  tombstonedIds: ReadonlySet<string>,
): CommentDTO[] {
  const merged = reconcileComments(prev, next);
  if (pendingCreateIds.size === 0) return merged;
  const present = new Set(merged.map((c) => c.id));
  let result = merged;
  for (const c of prev) {
    if (pendingCreateIds.has(c.id) && !present.has(c.id) && !tombstonedIds.has(c.id)) {
      result = mergeComment(result, c);
    }
  }
  return result;
}

/**
 * Merge ONE freshly fetched comment into the list (delta refetch, perf C4/H9),
 * preserving structural sharing: an unchanged row returns `prev` untouched, a
 * changed row swaps only its own slot, and a new row is inserted in
 * `created_at` order (matching the server's list ordering) so a later full
 * refetch compares order-stable.
 */
export function mergeComment(prev: CommentDTO[], incoming: CommentDTO): CommentDTO[] {
  const idx = prev.findIndex((c) => c.id === incoming.id);
  if (idx !== -1) {
    // Lengths checked via findIndex — the slot exists.
    if (commentSignature(prev[idx]!) === commentSignature(incoming)) return prev;
    const next = prev.slice();
    next[idx] = incoming;
    return next;
  }
  let at = prev.length;
  while (at > 0 && prev[at - 1]!.created_at.localeCompare(incoming.created_at) > 0) at--;
  return [...prev.slice(0, at), incoming, ...prev.slice(at)];
}

/**
 * Drop a comment (and, for a root, its replies) from the list — the local
 * handling of a `delete` broadcast signal: no fetch at all. Returns `prev`
 * unchanged when the id isn't present (already removed optimistically).
 */
export function dropComment(prev: CommentDTO[], commentId: string): CommentDTO[] {
  const next = prev.filter((c) => c.id !== commentId && c.parent_id !== commentId);
  return next.length === prev.length ? prev : next;
}

/**
 * Thread-object memo (perf C3): keyed by the ROOT comment object, so it only
 * hits when the root kept its identity through `reconcileComments`. The cached
 * thread is reused when its replies are also reference-equal — unchanged
 * threads keep their identity across rebuilds, unlocking React.memo on the
 * per-thread components. WeakMap: dropped roots release their entry.
 */
const threadCache = new WeakMap<CommentDTO, CommentThreadDTO>();

function sameReplyRefs(a: CommentDTO[], b: CommentDTO[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Group a flat comment list into top-level threads (roots + their replies).
 * Structural sharing: a thread whose root AND replies are all reference-equal
 * to the previous build returns the SAME CommentThreadDTO object (see threadCache).
 */
export function buildThreads(comments: CommentDTO[]): CommentThreadDTO[] {
  const roots = comments.filter((c) => c.parent_id === null);
  const repliesByParent = new Map<string, CommentDTO[]>();
  for (const c of comments) {
    if (c.parent_id === null) continue;
    const list = repliesByParent.get(c.parent_id) ?? [];
    list.push(c);
    repliesByParent.set(c.parent_id, list);
  }
  return roots.map((root) => {
    const replies = (repliesByParent.get(root.id) ?? []).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    const cached = threadCache.get(root);
    if (cached && sameReplyRefs(cached.replies, replies)) return cached;
    const thread: CommentThreadDTO = { root, replies };
    threadCache.set(root, thread);
    return thread;
  });
}

export { CommentsApiError };
export type { Role };
