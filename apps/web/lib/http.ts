import { NextResponse } from "next/server";

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function error(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

// User-specific bodies (reaction `mine` flags) must never land in a shared cache,
// but they CAN be conditionally revalidated per client via ETag — hence
// `private, no-cache` rather than `no-store`.
const REVALIDATE_CACHE_CONTROL = "private, no-cache";

/** Build a weak validator (`W/"…"`) from stable, cheap-to-compute parts. */
export function weakEtag(parts: (string | number)[]): string {
  return `W/"${parts.join(":")}"`;
}

/**
 * Weak comparison of the request's If-None-Match against our current ETag.
 * The client echoes back exactly what we sent, so an exact match is the common
 * path; we also tolerate the W/ prefix being present or absent on either side.
 */
export function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((tag) => {
    const v = tag.trim();
    return v === etag || v.replace(/^W\//, "") === bare;
  });
}

/** 304 with an empty body — collapses an unchanged refetch to ~0 bytes. */
export function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, "Cache-Control": REVALIDATE_CACHE_CONTROL },
  });
}

/** Like `json`, but carries the ETag + revalidation Cache-Control for conditional GETs. */
export function jsonWithEtag<T>(data: T, etag: string, status = 200): NextResponse {
  const res = NextResponse.json(data, { status });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", REVALIDATE_CACHE_CONTROL);
  return res;
}
