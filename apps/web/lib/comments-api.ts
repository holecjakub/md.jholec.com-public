/**
 * Typed client for the commenting endpoints (Plan 04). Mirrors the server
 * contracts in app/api/d/[slug]/comments/* and /share. All calls are
 * same-origin and rely on the httpOnly md_session cookie for auth.
 */

import type { TextQuoteAnchor } from "@md/core";
import type { Role } from "./document-api";

export type CommentStatus = "open" | "resolved";

export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

/** A comment row as returned by GET /comments (enriched with author + reactions). */
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

/** A top-level comment with its replies, assembled client-side from the flat list. */
export interface CommentThread {
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
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      const e = (body as { error: unknown }).error;
      if (typeof e === "string") message = e;
    }
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

export async function fetchComments(slug: string): Promise<CommentDTO[]> {
  const res = await fetch(`${base(slug)}/comments`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, "Failed to load comments");
  const data = (await res.json()) as CommentsResponse;
  return data.comments;
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

/** Group a flat comment list into top-level threads (roots + their replies). */
export function buildThreads(comments: CommentDTO[]): CommentThread[] {
  const roots = comments.filter((c) => c.parent_id === null);
  const repliesByParent = new Map<string, CommentDTO[]>();
  for (const c of comments) {
    if (c.parent_id === null) continue;
    const list = repliesByParent.get(c.parent_id) ?? [];
    list.push(c);
    repliesByParent.set(c.parent_id, list);
  }
  return roots.map((root) => ({
    root,
    replies: (repliesByParent.get(root.id) ?? []).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    ),
  }));
}

export { CommentsApiError };
export type { Role };
