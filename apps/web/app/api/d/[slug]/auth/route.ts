import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { verifyPassword } from "@/lib/crypto/password";
import { clientIp, isRateLimited } from "@/lib/auth/rate-limit";
import { setSessionCookie } from "@/lib/auth/cookies";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ password: z.string().min(1), name: z.string().min(1).max(120) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data: doc } = await db
    .from("documents")
    .select("id, password_hash")
    .eq("slug", slug)
    .maybeSingle();
  if (!doc) return error(404, "Document not found");

  if (await isRateLimited(doc.id, clientIp(req))) return error(429, "Too many attempts");

  if (!(await verifyPassword(doc.password_hash, parsed.data.password))) {
    return error(401, "Invalid credentials");
  }

  const { data: participant } = await db
    .from("participants")
    .insert({ document_id: doc.id, display_name: parsed.data.name, role: "reviewer" })
    .select("id")
    .single();
  if (!participant) return error(500, "Failed to create participant");

  await setSessionCookie({ doc: doc.id, pid: participant.id, role: "reviewer" });
  return noStore(json({ participantId: participant.id, role: "reviewer" }));
}
