import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { sha256hex } from "@/lib/crypto/tokens";
import { evaluateAccessToken, type AccessTokenRow } from "@/lib/capability";
import { setSessionCookie } from "@/lib/auth/cookies";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ token: z.string().min(1), name: z.string().min(1).max(120) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  // Rate-limit BEFORE the token lookup: this is the most privileged token path (it mints
  // an owner/reviewer session), so throttle guessing of a leaked/shared link per IP.
  const ip = clientIp(req);
  if (await isIpRateLimited(ip, "redeem")) {
    return noStore(error(429, "Too many requests"));
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  // A DB error is an outage, not a missing row — don't mask it as 404/401 (audit 3.5).
  if (docErr) return error(500, "Failed to load document");
  if (!doc) return error(404, "Document not found");

  const tokenHash = sha256hex(parsed.data.token);
  const { data: row, error: rowErr } = await db
    .from("access_tokens")
    .select("id, document_id, kind, reusable, consumed_at, expires_at, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (rowErr) return error(500, "Failed to validate token");
  if (!row) return error(401, "Invalid token");

  const decision = evaluateAccessToken(row as AccessTokenRow, doc.id, new Date());
  if (!decision.ok) return error(401, "Invalid token");

  // Consume single-use tokens atomically BEFORE minting any session. The conditional
  // update (consumed_at IS NULL) acts as a compare-and-swap: two concurrent redeems race
  // on the same row and only one gets a matching row back, so only one mints a session.
  if (!row.reusable) {
    const { data: consumed } = await db
      .from("access_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("consumed_at", null)
      .select("id");
    if (!consumed || consumed.length !== 1) return error(401, "Invalid token");
  }

  const role = row.kind === "owner" ? "owner" : "reviewer";
  const { data: participant } = await db
    .from("participants")
    .insert({ document_id: doc.id, display_name: parsed.data.name, role })
    .select("id")
    .single();
  if (!participant) return error(500, "Failed to create participant");

  await setSessionCookie({ doc: doc.id, pid: participant.id, role });
  const res = noStore(json({ participantId: participant.id, role }));
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
