export interface AccessTokenRow {
  document_id: string;
  kind: "invite" | "owner";
  reusable: boolean;
  consumed_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; reason: "wrong_doc" | "expired" | "revoked" | "consumed" };

export function evaluateAccessToken(
  row: AccessTokenRow,
  documentId: string,
  now: Date,
): AccessDecision {
  if (row.document_id !== documentId) return { ok: false, reason: "wrong_doc" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (new Date(row.expires_at).getTime() < now.getTime()) return { ok: false, reason: "expired" };
  if (!row.reusable && row.consumed_at !== null) return { ok: false, reason: "consumed" };
  return { ok: true };
}
