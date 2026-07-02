import { admin } from "../db/admin";
import { generateToken, sha256hex } from "../crypto/tokens";

// TTL for export tokens (agent-read). Single source of truth shared with pat/route.ts.
// 30d matches GitHub fine-grained PAT default expectations and is revocable at any time.
const EXPORT_TTL_MS = 30 * 86_400_000;

export const EXPORT_SCOPES = ["docs:read", "comments:read"] as const;

export interface MintedExportToken {
  /** The raw (plaintext) token — shown once; never stored. */
  token: string;
}

/**
 * Mint a read-only agent export PAT bound to `documentId`.
 * Scopes are server-pinned to EXACTLY ['docs:read','comments:read'] — callers cannot
 * widen them. TTL is 30 days. Returns the plaintext token (shown once); only the
 * SHA-256 hash is persisted.
 *
 * Used by:
 *  - POST /api/documents (auto-mint on creation)
 *  - POST /api/d/<slug>/pat (kind === 'export' — owner-gated re-mint)
 */
export async function mintExportToken(documentId: string): Promise<MintedExportToken> {
  const token = `pat_${generateToken()}`;
  const db = admin();
  const { error: e } = await db.from("personal_access_tokens").insert({
    token_hash: sha256hex(token),
    name: "AI agent (read-only)",
    scopes: [...EXPORT_SCOPES],
    document_id: documentId,
    expires_at: new Date(Date.now() + EXPORT_TTL_MS).toISOString(),
  });
  if (e) throw new Error(`Failed to mint export token: ${e.message}`);
  return { token };
}

export interface PatContext {
  id: string;
  ownerEmail: string | null;
  accountId: string | null;
  scopes: string[];
  /** The single document this PAT is authorized for (security review C2). */
  documentId: string | null;
}

export type PatResult =
  | { ok: true; pat: PatContext }
  | { ok: false; status: 401 | 403; message: string };

export async function requirePat(req: Request, requiredScope: string): Promise<PatResult> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return { ok: false, status: 401, message: "Missing bearer token" };
  return validatePatToken(match[1]!, requiredScope);
}

/**
 * Validate a raw PAT value (e.g. extracted from a URL path segment) against a single
 * required scope. Hashes the token, looks it up, checks revoked/expired/scope, bumps
 * last_used_at, and returns a PatResult.
 *
 * Use this when the token is NOT in an Authorization header — e.g. the GET capability
 * route where the token is embedded in the URL path. The caller is responsible for
 * any additional document-binding check (pat.documentId === expectedDocumentId).
 *
 * Single required-scope variant. For multi-scope enforcement, call this once per scope
 * or use validatePatTokenScopes below.
 */
export async function validatePatToken(rawToken: string, requiredScope: string): Promise<PatResult> {
  return validatePatTokenScopes(rawToken, [requiredScope]);
}

/**
 * Validate a raw PAT value against ALL of the given required scopes. Every scope in
 * `requiredScopes` must be present; a missing scope returns 403.
 */
export async function validatePatTokenScopes(rawToken: string, requiredScopes: string[]): Promise<PatResult> {
  const tokenHash = sha256hex(rawToken);

  const db = admin();
  const { data } = await db
    .from("personal_access_tokens")
    .select("id, owner_email, account_id, scopes, document_id, expires_at, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!data) return { ok: false, status: 401, message: "Invalid token" };
  if (data.revoked_at) return { ok: false, status: 401, message: "Token revoked" };
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, message: "Token expired" };
  }
  const scopes: string[] = data.scopes ?? [];
  for (const s of requiredScopes) {
    if (!scopes.includes(s)) {
      return { ok: false, status: 403, message: `Missing scope: ${s}` };
    }
  }
  await db.from("personal_access_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return {
    ok: true,
    pat: {
      id: data.id,
      ownerEmail: data.owner_email,
      accountId: data.account_id,
      scopes,
      documentId: data.document_id ?? null,
    },
  };
}
