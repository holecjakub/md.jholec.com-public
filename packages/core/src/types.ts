export type DocId = string;

export interface Comment {
  id: string;
  documentId: DocId;
  body: string;
  parentId: string | null;
  status: "open" | "resolved";
  createdAt: string;
}

export interface ClientConfig {
  baseUrl: string;
  token: string;
}

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  blockId: string;
}

export interface Reaction {
  id: string;
  commentId: string | null;
  emoji: string;
  participantId: string;
  createdAt: string;
}

export interface DocumentSummary {
  slug: string;
  title: string;
  versionNo: number;
  updatedAt: string;
}

export interface DocumentDetail {
  slug: string;
  title: string;
  content: string;
  versionNo: number;
}

export interface CreateDocInput {
  title: string;
  content: string;
  password: string;
}

export interface CreateDocResult {
  slug: string;
  shareUrl: string;
  ownerUrl: string;
  /** Read-only agent GET capability URL (`/d/<slug>/agent/<token>`). */
  agentUrl: string;
  /** ISO timestamp when the document auto-deletes. */
  expiresAt: string;
}

/** Result of minting an agent read link for an existing owned document. */
export interface AgentLinkResult {
  /** The read-only export PAT (shown once). */
  token: string;
  /** The agent read URL: `<origin>/d/<slug>/agent/<token>`. */
  url: string;
}

export interface PushVersionResult {
  versionNo: number;
}

export interface CommentThread {
  root: Comment;
  replies: Comment[];
  reactions: Reaction[];
}

export interface WhoAmI {
  ownerEmail: string | null;
  scopes: string[];
}

// ── Agent-read export types ────────────────────────────────────────────────

/**
 * A provenance-fenced field wrapper for participant-authored content.
 * Every untrusted field (comment body, reply body, author display_name,
 * anchor quote/prefix/suffix) is wrapped in this shape so a consuming
 * agent treats them strictly as DATA, never as instructions.
 *
 * NOTE: the JSON value is delimiter-safe by construction — JSON.stringify
 * escapes `-->`, quotes, and control bytes automatically. The HTML-comment
 * fence escape (encodeCommentSafe) is NOT needed here; that is only for the
 * markdown appendix. Do not double-escape.
 */
export interface Fenced {
  source: string;
  untrusted: true;
  value: string;
}

/**
 * Build a Fenced wrapper for a participant-authored value.
 */
export function fenced(source: string, value: string): Fenced {
  return { source, untrusted: true, value };
}

export interface AgentExportReply {
  author: Fenced;
  body: Fenced;
  at: string;
}

export interface AgentExportThread {
  anchor: {
    quote: Fenced;
    prefix: Fenced;
    suffix: Fenced;
    blockId: string | undefined;
  };
  author: Fenced;
  body: Fenced;
  at: string;
  status: "open" | "resolved";
  // emoji is participant-controlled free text, so it carries the same untrusted
  // provenance envelope as every other reviewer-authored field on this endpoint.
  reactions: Array<{ emoji: Fenced; count: number }>;
  replies: AgentExportReply[];
}

export interface AgentExport {
  format: "md.jholec.com/agent-export";
  version: 1;
  document: { slug: string; title: string };
  content: { source: "owner-document"; untrusted: false; value: string };
  guidance: string;
  threads: AgentExportThread[];
}
