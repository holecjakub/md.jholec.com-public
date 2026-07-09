import { describe, it, expect } from "vitest";
import { ifNoneMatch, jsonWithEtag, notModified, weakEtag } from "../http";

function reqWith(header?: string): Request {
  return new Request("http://localhost/api/d/x/comments", {
    headers: header !== undefined ? { "If-None-Match": header } : undefined,
  });
}

describe("weakEtag", () => {
  it("joins parts into a weak validator", () => {
    expect(weakEtag(["c", 3, "2026-01-01", "r", 0, ""])).toBe('W/"c:3:2026-01-01:r:0:"');
  });

  it("changes when any part changes", () => {
    expect(weakEtag(["c", 3])).not.toBe(weakEtag(["c", 4]));
  });
});

describe("ifNoneMatch", () => {
  const etag = weakEtag(["c", 2, "t1", "r", 1, "t2", "o0"]);

  it("is false without an If-None-Match header", () => {
    expect(ifNoneMatch(reqWith(), etag)).toBe(false);
  });

  it("matches the exact echoed validator (common path)", () => {
    expect(ifNoneMatch(reqWith(etag), etag)).toBe(true);
  });

  it("is false for a different validator", () => {
    expect(ifNoneMatch(reqWith('W/"stale"'), etag)).toBe(false);
  });

  it("tolerates a missing W/ prefix on the request side", () => {
    expect(ifNoneMatch(reqWith(etag.replace(/^W\//, "")), etag)).toBe(true);
  });

  it("tolerates a missing W/ prefix on our side", () => {
    expect(ifNoneMatch(reqWith('W/"abc"'), '"abc"')).toBe(true);
  });

  it("scans comma-separated candidate lists", () => {
    expect(ifNoneMatch(reqWith(`W/"other", ${etag}, W/"more"`), etag)).toBe(true);
    expect(ifNoneMatch(reqWith('W/"a", W/"b"'), etag)).toBe(false);
  });

  it("does not treat a substring as a match", () => {
    expect(ifNoneMatch(reqWith('W/"c:2"'), etag)).toBe(false);
  });
});

describe("notModified", () => {
  it("returns 304 with an empty body and the validator + private revalidation headers", async () => {
    const etag = 'W/"v1"';
    const res = notModified(etag);
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await res.text()).toBe("");
  });
});

describe("jsonWithEtag", () => {
  it("carries the body, the validator, and the private revalidation Cache-Control", async () => {
    const etag = 'W/"v2"';
    const res = jsonWithEtag({ comments: [] }, etag);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await res.json()).toEqual({ comments: [] });
  });

  it("round-trips through ifNoneMatch (send → echo → 304 decision)", () => {
    const etag = weakEtag(["c", 5, "t", "r", 2, "t2", "o1"]);
    const res = jsonWithEtag({ ok: true }, etag);
    const echoed = reqWith(res.headers.get("ETag")!);
    expect(ifNoneMatch(echoed, etag)).toBe(true);
  });
});
