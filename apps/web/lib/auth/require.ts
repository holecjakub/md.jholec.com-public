import { admin } from "../db/admin";
import { readSession } from "./cookies";
import { requirePat } from "./pat";
import type { Role } from "./session";

export interface DocAccess {
  documentId: string;
  participantId: string | null;
  role: Role;
  viaPat: boolean;
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
  const { data: doc } = await db.from("documents").select("id").eq("slug", slug).maybeSingle();
  if (!doc) return { ok: false, status: 404, message: "Document not found" };

  const session = await readSession();
  if (session && session.doc === doc.id) {
    return { ok: true, access: { documentId: doc.id, participantId: session.pid, role: session.role, viaPat: false } };
  }

  if (req.headers.get("authorization")) {
    const pat = await requirePat(req, patScope);
    if (!pat.ok) return { ok: false, status: pat.status, message: pat.message };
    // A PAT is owner ONLY of the single document it was minted for. Without this
    // check any valid PAT was treated as owner of EVERY document (review C2).
    if (pat.pat.documentId !== doc.id) {
      return { ok: false, status: 403, message: "Token not authorized for this document" };
    }
    return { ok: true, access: { documentId: doc.id, participantId: null, role: "owner", viaPat: true } };
  }

  return { ok: false, status: 401, message: "Authentication required" };
}
