/**
 * Client-side fetch wrappers for the upload feature.
 * Never import @/lib/env here — the client only sees HTTP status codes.
 */

export interface CreateResult {
  slug: string;
  shareUrl: string;
  ownerUrl: string;
  /** Read-only agent GET capability URL (`/d/<slug>/agent/<token>`) — fetching it returns visible doc+comments HTML. */
  agentUrl: string;
  expiresAt: string;
}

interface ErrorBody {
  error: string;
}

/** Narrow an unknown JSON body to the API error shape. */
function readErrorMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ErrorBody).error === "string"
  ) {
    return (body as ErrorBody).error;
  }
  return fallback;
}

/** POST /api/early-access { password } — returns status + ok flag. */
export async function postEarlyAccess(
  password: string,
): Promise<{ status: number; ok: boolean }> {
  const res = await fetch("/api/early-access", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, ok: res.ok };
}

/** POST /api/documents { title, content, password } — returns 201 result or error. */
export async function createDocument(body: {
  title: string;
  content: string;
  password: string;
}): Promise<{
  status: number;
  result: CreateResult | null;
  errorMessage: string | null;
}> {
  const res = await fetch("/api/documents", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 201) {
    const result = (await res.json()) as CreateResult;
    return { status: 201, result, errorMessage: null };
  }

  const fallback = "Something went wrong. Please try again.";
  let errorMessage = fallback;
  try {
    errorMessage = readErrorMessage(await res.json(), fallback);
  } catch {
    // Non-JSON body; keep fallback.
  }
  return { status: res.status, result: null, errorMessage };
}
