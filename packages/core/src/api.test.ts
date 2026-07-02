import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { createApi } from "./api";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createApi", () => {
  it("pullDocument GETs the document and returns its detail", async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse({
        document: { slug: "abc", title: "T" },
        version: { versionNo: 1, content: "# Hi" },
      }),
    );
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "pat_1" }), fetchMock);
    const doc = await api.pullDocument("abc");
    expect(doc).toEqual({ slug: "abc", title: "T", content: "# Hi", versionNo: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/d/abc");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer pat_1" });
  });

  it("pushVersion POSTs new content and returns the new version number", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse({ versionNo: 2 }, 201));
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "pat_1" }), fetchMock);
    const res = await api.pushVersion("abc", "# Edited", "New title");
    expect(res).toEqual({ versionNo: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/d/abc/versions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ content: "# Edited", title: "New title" });
  });

  it("throws ApiError with status on non-2xx", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse({ error: "nope" }, 403));
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "pat_1" }), fetchMock);
    await expect(api.pullDocument("abc")).rejects.toMatchObject({ status: 403 });
  });

  it("unlockEarlyAccess POSTs the password and returns the grant cookie value", async () => {
    const fetchMock = vi.fn<FetchFn>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "md_early_access=GRANT123; Path=/; HttpOnly; SameSite=Lax",
          },
        }),
    );
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "none" }), fetchMock);
    const grant = await api.unlockEarlyAccess("secret");
    expect(grant).toBe("GRANT123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/early-access");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ password: "secret" });
  });

  it("unlockEarlyAccess surfaces the server error on a wrong password", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse({ error: "Wrong password" }, 401));
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "none" }), fetchMock);
    await expect(api.unlockEarlyAccess("bad")).rejects.toMatchObject({
      status: 401,
      message: "Wrong password",
    });
  });

  it("pushDocument forwards the early-access grant as the gate cookie", async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse(
        {
          slug: "abc",
          shareUrl: "https://x/d/abc#t=1",
          ownerUrl: "https://x/d/abc#o=2",
          agentUrl: "https://x/d/abc/agent/pat_3",
          expiresAt: "2026-07-01T00:00:00Z",
        },
        201,
      ),
    );
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "none" }), fetchMock);
    const res = await api.pushDocument(
      { title: "T", content: "# Hi", password: "abcdefgh" },
      "GRANT123",
    );
    expect(res.agentUrl).toBe("https://x/d/abc/agent/pat_3");
    expect(res.expiresAt).toBe("2026-07-01T00:00:00Z");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/documents");
    expect(init?.headers).toMatchObject({ Cookie: "md_early_access=GRANT123" });
  });

  it("mintAgentLink mints an export PAT and builds the site-origin agent URL", async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse({ token: "pat_export9" }, 201));
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "pat_owner" }), fetchMock);
    const res = await api.mintAgentLink("abc");
    expect(res).toEqual({ token: "pat_export9", url: "https://x/d/abc/agent/pat_export9" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/d/abc/pat");
    expect(JSON.parse(init?.body as string)).toMatchObject({ kind: "export" });
  });

  it("setCommentStatus PATCHes the comment status and returns id + status", async () => {
    const fetchMock = vi.fn<FetchFn>(async () =>
      jsonResponse({ comment: { id: "c1", status: "resolved" } }),
    );
    const api = createApi(createClient({ baseUrl: "https://x/api", token: "pat_owner" }), fetchMock);
    const res = await api.setCommentStatus("abc", "c1", "resolved");
    expect(res).toEqual({ id: "c1", status: "resolved" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/api/d/abc/comments/c1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ status: "resolved" });
  });
});
