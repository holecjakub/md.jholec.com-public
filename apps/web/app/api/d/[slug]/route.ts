import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { listEnrichedComments, type EnrichedComment } from "@/lib/comments/list";
import { error, ifNoneMatch, jsonWithEtag, notModified, weakEtag } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "docs:read");
  if (!access.ok) return error(access.status, access.message);

  // requireDocAccess already carries title + current_version_id — no re-select (perf H10).
  const { documentId, title, currentVersionId, participantId, viaPat, patScopes } =
    access.access;

  // Comments ride along only when the caller may read them: any cookie session,
  // or a PAT that actually carries comments:read. A docs:read-only PAT must not
  // widen its scope through this embed.
  const canReadComments = !viaPat || patScopes.includes("comments:read");

  // Weak ETag keyed on the current version: the doc body only changes when a new
  // version is published (perf M2 — a reconnect that finds the same version pays
  // ~0 bytes). The embedded comments are a first-paint convenience; their
  // freshness rides the separate GET /comments channel (its own ETag), so a doc
  // 304 never strands a client on stale comments.
  const etag = weakEtag(["d", currentVersionId ?? ""]);
  if (ifNoneMatch(req, etag)) return notModified(etag);

  const db = admin();
  // Version, participant roster, and initial comments are independent — run them
  // in parallel (perf H10), and embedding comments here saves the client a second
  // sequential round trip on load (perf H1). GET /comments stays for realtime refetches.
  const [{ data: version, error: versionErr }, { data: participantRows }, comments] =
    await Promise.all([
      db
        .from("document_versions")
        .select("version_no, content")
        .eq("id", currentVersionId)
        .maybeSingle(),
      // Participant roster (names only) for the owner toolbar. Cheap single query;
      // names are not secret to a session holder for this document.
      db
        .from("participants")
        .select("id, display_name, role")
        .eq("document_id", documentId)
        .order("created_at", { ascending: true }),
      canReadComments
        ? listEnrichedComments(documentId, participantId).catch(
            (): EnrichedComment[] | null => null,
          )
        : Promise.resolve<EnrichedComment[]>([]),
    ]);
  // A DB error is an outage, not a missing row — don't mask it as 404 (audit 3.5).
  if (versionErr) return error(500, "Failed to load version");
  if (!version) return error(404, "Version not found");
  if (!comments) return error(500, "Failed to list comments");

  return jsonWithEtag({
    document: { slug, title },
    documentId,
    version: { versionNo: version.version_no, content: version.content },
    role: access.access.role,
    participantId,
    participants: (participantRows ?? []).map((p) => ({
      id: p.id,
      name: p.display_name,
      role: p.role,
    })),
    comments,
  }, etag);
}
