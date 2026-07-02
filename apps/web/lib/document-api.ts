/**
 * Client-side helpers + types for the document-viewing experience (Plan 03).
 * These mirror the server contracts in app/api/d/[slug]/*. The client never
 * reads the md_session cookie directly; auth state is derived purely from
 * whether GET /api/d/[slug] returns 200.
 */

export type Role = "owner" | "reviewer";

export interface ParticipantSummary {
  id: string;
  name: string;
  role: Role;
}

export interface DocPayload {
  document: { slug: string; title: string };
  documentId: string;
  version: { versionNo: number; content: string };
  role: Role;
  participantId: string | null;
  participants: ParticipantSummary[];
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

export interface FetchDocResult {
  status: number;
  payload: DocPayload | null;
  errorMessage: string | null;
}

/** GET /api/d/[slug] — returns status so the caller can drive the gate/render state machine. */
export async function fetchDocument(slug: string): Promise<FetchDocResult> {
  const res = await fetch(`/api/d/${encodeURIComponent(slug)}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.ok) {
    const payload = (await res.json()) as DocPayload;
    return { status: res.status, payload, errorMessage: null };
  }

  let message = "Something went wrong. Please try again.";
  try {
    message = readErrorMessage(await res.json(), message);
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  return { status: res.status, payload: null, errorMessage: message };
}

export interface AuthResult {
  status: number;
  ok: boolean;
  errorMessage: string | null;
}

/** POST /api/d/[slug]/redeem — exchange an invite/owner token for a session. */
export async function redeemToken(
  slug: string,
  token: string,
  name: string,
): Promise<AuthResult> {
  return postAuth(`/api/d/${encodeURIComponent(slug)}/redeem`, { token, name });
}

/** POST /api/d/[slug]/auth — exchange a password for a session. */
export async function authenticate(
  slug: string,
  password: string,
  name: string,
): Promise<AuthResult> {
  return postAuth(`/api/d/${encodeURIComponent(slug)}/auth`, { password, name });
}

async function postAuth(
  url: string,
  body: Record<string, string>,
): Promise<AuthResult> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    return { status: res.status, ok: true, errorMessage: null };
  }

  let message = "Something went wrong. Please try again.";
  try {
    message = readErrorMessage(await res.json(), message);
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  return { status: res.status, ok: false, errorMessage: message };
}
