import { admin } from "../db/admin";
import { readSession } from "./cookies";
import { OWNER_SCOPE, requirePat } from "./pat";
import type { Role } from "./session";

export interface DocAccess {
  documentId: string;
  /** Document title, carried from the access lookup so routes need no re-select (perf H10). */
  title: string;
  /** Current version id (null for a doc without content), carried for the same reason. */
  currentVersionId: string | null;
  participantId: string | null;
  /** Cookie-session role. PATs are not participant sessions and report "reviewer". */
  role: Role;
  viaPat: boolean;
  /** Actual scopes carried by the PAT; empty for cookie sessions (security review M1). */
  patScopes: readonly string[];
  /**
   * True owner authority: an owner cookie session, or a PAT explicitly granted
   * OWNER_SCOPE ("tokens:mint"). A PAT's document binding and content scopes alone
   * never confer this (security review M1). Credential-minting routes (/share, /pat)
   * MUST gate on this field, never on `role`.
   */
  ownerAuthority: boolean;
}

/**
 * Owner-level authority for CONTENT routes (download, versions, comment
 * resolve/delete): a true owner, or any PAT that reached the route — the PAT is
 * owner-minted, bound to this document, and already passed the route's scope
 * check in requireDocAccess. Reviewer sessions stay blocked. Do NOT use this for
 * credential-minting routes; those must check `access.ownerAuthority`.
 */
export function hasOwnerContentAuthority(access: DocAccess): boolean {
  return access.ownerAuthority || access.viaPat;
}

export type AccessResult =
  | { ok: true; access: DocAccess }
  | { ok: false; status: 401 | 403 | 404; message: string };

/**
 * Resolves access to the document identified by `slug` via either the session
 * cookie (browser) or a PAT (CLI). PAT requires `patScope`.
 */
export async function requireDocAccess(
  req: Request,
  slug: string,
  patScope: string,
): Promise<AccessResult> {
  const db = admin();
  // Select the fields routes always need (title, current_version_id) alongside id so
  // handlers don't immediately re-select the same documents row (perf H10).
  const { data: doc } = await db
    .from("documents")
    .select("id, title, current_version_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!doc) return { ok: false, status: 404, message: "Document not found" };

  const session = await readSession();
  if (session && session.doc === doc.id) {
    return {
      ok: true,
      access: {
        documentId: doc.id,
        title: doc.title,
        currentVersionId: doc.current_version_id,
        participantId: session.pid,
        role: session.role,
        viaPat: false,
        patScopes: [],
        ownerAuthority: session.role === "owner",
      },
    };
  }

  if (req.headers.get("authorization")) {
    const pat = await requirePat(req, patScope);
    if (!pat.ok) return { ok: false, status: pat.status, message: pat.message };
    // A PAT is scoped ONLY to the single document it was minted for. Without this
    // check any valid PAT was treated as authorized for EVERY document (review C2).
    if (pat.pat.documentId !== doc.id) {
      return { ok: false, status: 403, message: "Token not authorized for this document" };
    }
    // Do NOT synthesize role:"owner" for PATs (security review M1). Authority is
    // carried explicitly: patScopes holds the token's real scopes, and only a PAT
    // granted OWNER_SCOPE gets ownerAuthority (needed to mint links/tokens).
    return {
      ok: true,
      access: {
        documentId: doc.id,
        title: doc.title,
        currentVersionId: doc.current_version_id,
        participantId: null,
        role: "reviewer",
        viaPat: true,
        patScopes: pat.pat.scopes,
        ownerAuthority: pat.pat.scopes.includes(OWNER_SCOPE),
      },
    };
  }

  return { ok: false, status: 401, message: "Authentication required" };
}
