import type { ApiClient } from "./client";
import type {
  AgentLinkResult,
  Comment,
  CreateDocInput,
  CreateDocResult,
  DocumentDetail,
  PushVersionResult,
  Reaction,
  RevokeResult,
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
  /**
   * Revoke ALL personal access tokens bound to an owned document — CLI PATs and
   * agent read links alike. Requires owner authority ("tokens:mint"); note that the
   * PAT making this call is itself bound to the document and is revoked too.
   */
  revokeTokens(slug: string): Promise<RevokeResult>;
  /** Revoke all reusable invite share links for an owned document (owner links survive). */
  revokeInvites(slug: string): Promise<RevokeResult>;
  listComments(slug: string, opts?: { open?: boolean }): Promise<Comment[]>;
  reply(slug: string, commentId: string, body: string): Promise<Comment>;
  react(slug: string, commentId: string, emoji: string): Promise<Reaction>;
  /** Resolve or reopen a comment thread (owner only). */
  setCommentStatus(
    slug: string,
    commentId: string,
    status: "open" | "resolved",
  ): Promise<{ id: string; status: "open" | "resolved" }>;
}

export function createApi(client: ApiClient, fetchFn: FetchFn = fetch): Api {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(`${client.baseUrl}${path}`, {
      ...init,
      headers: { ...client.headers, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    // Guard the parse: a proxy/CDN error page (e.g. an HTML 502) is not JSON, and an
    // unguarded JSON.parse would surface as a SyntaxError instead of an ApiError
    // carrying the HTTP status (same handling as unlockEarlyAccess/downloadDocument).
    let data: { error?: unknown } | null = null;
    let parseFailed = false;
    if (text) {
      try {
        data = JSON.parse(text) as { error?: unknown };
      } catch {
        parseFailed = true; // non-JSON body; fall through to status handling
      }
    }
    if (!res.ok) {
      const message =
        (data && typeof data.error === "string" && data.error) || `Request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    if (parseFailed) {
      throw new ApiError(res.status, "Malformed JSON in response body");
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
      const r = await request<{ token: string; expiresAt: string }>(`/d/${slug}/pat`, {
        method: "POST",
        body: JSON.stringify({ name: "AI agent (read-only)", kind: "export" }),
      });
      // baseUrl is the API origin (…/api); the agent route lives at the site origin.
      const origin = client.baseUrl.replace(/\/api$/, "");
      return { token: r.token, url: `${origin}/d/${slug}/agent/${r.token}`, expiresAt: r.expiresAt };
    },
    async revokeTokens(slug) {
      return request<RevokeResult>(`/d/${slug}/pat`, { method: "DELETE" });
    },
    async revokeInvites(slug) {
      return request<RevokeResult>(`/d/${slug}/share`, { method: "DELETE" });
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
    async listComments(slug, opts) {
      const qs = opts?.open ? "?open=true" : "";
      const r = await request<{ comments: Comment[] }>(`/d/${slug}/comments${qs}`);
      return r.comments;
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
  };
}
