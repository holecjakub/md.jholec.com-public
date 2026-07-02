import type { ApiClient } from "./client";
import type {
  AgentLinkResult,
  Comment,
  CommentThread,
  CreateDocInput,
  CreateDocResult,
  DocumentDetail,
  DocumentSummary,
  PushVersionResult,
  Reaction,
  WhoAmI,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Api {
  /**
   * Unlock the early-access gate with the shared password and return the grant
   * cookie value. Pass it to `pushDocument` so a non-browser client (the CLI) can
   * create a document while the gate is active.
   */
  unlockEarlyAccess(password: string): Promise<string>;
  /** Create a document. `earlyAccessGrant` (from `unlockEarlyAccess`) is sent as the gate cookie. */
  pushDocument(input: CreateDocInput, earlyAccessGrant?: string): Promise<CreateDocResult>;
  pullDocument(slug: string): Promise<DocumentDetail>;
  /** Raw .md download (owner) — includes the embedded comments appendix. */
  downloadDocument(slug: string): Promise<string>;
  pushVersion(slug: string, content: string, title?: string): Promise<PushVersionResult>;
  /** Mint a read-only export PAT for an owned document and return its agent read URL. */
  mintAgentLink(slug: string): Promise<AgentLinkResult>;
  listDocuments(): Promise<DocumentSummary[]>;
  listComments(slug: string, opts?: { open?: boolean }): Promise<Comment[]>;
  getThread(slug: string, commentId: string): Promise<CommentThread>;
  reply(slug: string, commentId: string, body: string): Promise<Comment>;
  react(slug: string, commentId: string, emoji: string): Promise<Reaction>;
  /** Resolve or reopen a comment thread (owner only). */
  setCommentStatus(
    slug: string,
    commentId: string,
    status: "open" | "resolved",
  ): Promise<{ id: string; status: "open" | "resolved" }>;
  whoami(): Promise<WhoAmI>;
}

export function createApi(client: ApiClient, fetchFn: FetchFn = fetch): Api {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(`${client.baseUrl}${path}`, {
      ...init,
      headers: { ...client.headers, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message =
        (data && typeof data.error === "string" && data.error) || `Request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  return {
    async unlockEarlyAccess(password) {
      const res = await fetchFn(`${client.baseUrl}/early-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = `Request failed (${res.status})`;
        try {
          const data = JSON.parse(text) as { error?: string };
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // non-JSON error body; keep the default message
        }
        throw new ApiError(res.status, message);
      }
      // The grant is an httpOnly Set-Cookie; httpOnly only hides it from browser JS,
      // a direct HTTP client can still read the response header.
      const getSetCookie = (res.headers as { getSetCookie?: () => string[] }).getSetCookie;
      const cookies =
        typeof getSetCookie === "function"
          ? getSetCookie.call(res.headers)
          : [res.headers.get("set-cookie") ?? ""];
      for (const c of cookies) {
        const m = /md_early_access=([^;]+)/.exec(c);
        if (m) return m[1] as string;
      }
      throw new ApiError(500, "Unlock succeeded but no grant cookie was returned");
    },
    async pushDocument(input, earlyAccessGrant) {
      return request<CreateDocResult>("/documents", {
        method: "POST",
        body: JSON.stringify(input),
        headers: earlyAccessGrant
          ? { Cookie: `md_early_access=${earlyAccessGrant}` }
          : undefined,
      });
    },
    async mintAgentLink(slug) {
      const r = await request<{ token: string }>(`/d/${slug}/pat`, {
        method: "POST",
        body: JSON.stringify({ name: "AI agent (read-only)", kind: "export" }),
      });
      // baseUrl is the API origin (…/api); the agent route lives at the site origin.
      const origin = client.baseUrl.replace(/\/api$/, "");
      return { token: r.token, url: `${origin}/d/${slug}/agent/${r.token}` };
    },
    async setCommentStatus(slug, commentId, status) {
      const r = await request<{ comment: { id: string; status: "open" | "resolved" } }>(
        `/d/${slug}/comments/${commentId}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
      return { id: r.comment.id, status: r.comment.status };
    },
    async pullDocument(slug) {
      const r = await request<{
        document: { slug: string; title: string };
        version: { versionNo: number; content: string };
      }>(`/d/${slug}`);
      return {
        slug: r.document.slug,
        title: r.document.title,
        content: r.version.content,
        versionNo: r.version.versionNo,
      };
    },
    async downloadDocument(slug) {
      const res = await fetchFn(`${client.baseUrl}/d/${slug}/download`, {
        headers: { ...client.headers },
      });
      const text = await res.text();
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const data = JSON.parse(text) as { error?: string };
          if (data && typeof data.error === "string") message = data.error;
        } catch {
          // non-JSON error body; keep the default message
        }
        throw new ApiError(res.status, message);
      }
      return text;
    },
    async pushVersion(slug, content, title) {
      return request<PushVersionResult>(`/d/${slug}/versions`, {
        method: "POST",
        body: JSON.stringify(title ? { content, title } : { content }),
      });
    },
    async listDocuments() {
      const r = await request<{ documents: DocumentSummary[] }>("/documents");
      return r.documents;
    },
    async listComments(slug, opts) {
      const qs = opts?.open ? "?open=true" : "";
      const r = await request<{ comments: Comment[] }>(`/d/${slug}/comments${qs}`);
      return r.comments;
    },
    async getThread(slug, commentId) {
      return request<CommentThread>(`/d/${slug}/comments/${commentId}`);
    },
    async reply(slug, commentId, body) {
      const r = await request<{ comment: Comment }>(`/d/${slug}/comments/${commentId}/reply`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return r.comment;
    },
    async react(slug, commentId, emoji) {
      const r = await request<{ reaction: Reaction }>(`/d/${slug}/comments/${commentId}/react`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
      });
      return r.reaction;
    },
    async whoami() {
      return request<WhoAmI>("/whoami");
    },
  };
}
