/**
 * The md.jholec.com source-embedded comments convention (v1).
 *
 * Comments live in the database, not the markdown. But when a document is
 * downloaded / `md pull`-ed we append a single HTML-comment appendix so the file
 * is a self-contained record of the feedback — and so a tool (or a re-upload) can
 * recover it. The appendix is invisible in any markdown renderer (it is an HTML
 * comment) and is stripped before the content is stored again, so it never
 * pollutes the rendered document.
 *
 * Format (always at the very end of the file):
 *
 *   <!-- md.jholec.com/comments v1
 *   { "version": 1, "threads": [ ... ] }
 *   -->
 *
 * Security note — HTML-comment fence:
 * Any untrusted field (comment body, author name) could contain `-->` which
 * would terminate the HTML comment early, allowing fence breakout / stored
 * XSS and silently corrupting the round-trip parse. We neutralize this by
 * encoding the entire serialized JSON string (not individual fields) with a
 * C0-sentinel-based escape before embedding, and reversing it on parse.
 * See encodeCommentSafe / decodeCommentSafe below.
 *
 * Backward-compat: v1 appendices written before the escape fix are read no-op
 * (no marker byte present); the only behavioral change is that a genuinely
 * malformed appendix now throws instead of silently dropping threads.
 */

export interface EmbeddedReaction {
  emoji: string;
  count: number;
}

export interface EmbeddedComment {
  author: string;
  body: string;
  /** ISO-8601 timestamp. */
  at: string;
}

export interface EmbeddedThread extends EmbeddedComment {
  anchor: { quote: string; prefix?: string; suffix?: string; blockId?: string };
  status: "open" | "resolved";
  reactions: EmbeddedReaction[];
  replies: EmbeddedComment[];
}

export const COMMENTS_MARKER = "md.jholec.com/comments";
export const COMMENTS_VERSION = 1;

// Matches the appendix block (and any trailing whitespace) at the end of a file.
const BLOCK_RE = new RegExp(
  `\\n*<!--\\s*${COMMENTS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+v\\d+[\\s\\S]*?-->\\s*$`,
);

/**
 * Thrown when an appendix is present but its content cannot be parsed.
 * Message is intentionally generic — the raw payload is never echoed so
 * untrusted bytes cannot leak into logs or error surfaces.
 */
export class CommentsParseError extends Error {
  constructor() {
    super("Malformed comments appendix");
    this.name = "CommentsParseError";
  }
}

// --- HTML-comment fence escape helpers ---
//
// HYPHEN_MARK is U+0001 (SOH), a C0 control character. JSON.stringify of a string
// containing a raw U+0001 byte emits the six-char text sequence , NOT the raw
// byte — so a malicious body that happens to contain a literal U+0001 is already
// represented as the text  in the JSON output. Our encode step, which scans
// for the raw byte \x01, will therefore never collide with that representation.
// The raw byte only appears in the encoded string because we inserted it in step 2.
// This is why encode-the-escape-char-first is sufficient for a provably reversible scheme.
const HYPHEN_MARK = "\x01"; // C0 control; never emitted raw by JSON.stringify

function encodeCommentSafe(json: string): string {
  return json
    .replaceAll(HYPHEN_MARK, HYPHEN_MARK + "0") // escape the marker itself first
    .replaceAll("--", HYPHEN_MARK + "1"); // then neutralize every hyphen-pair
}

function decodeCommentSafe(s: string): string {
  return s
    .replaceAll(HYPHEN_MARK + "1", "--") // restore hyphen-pairs first
    .replaceAll(HYPHEN_MARK + "0", HYPHEN_MARK); // then restore escaped markers
}

/** Remove any embedded comments appendix, returning clean markdown. */
export function stripComments(md: string): string {
  return md.replace(BLOCK_RE, "").trimEnd() + "\n";
}

/**
 * Append (or replace) the comments appendix on `content`. With no threads the
 * content is returned clean (any existing appendix removed).
 *
 * The serialized JSON is encoded with encodeCommentSafe before embedding so that
 * no untrusted field value (comment body, author name, anchor quote) can terminate
 * the HTML comment early. decodeCommentSafe reverses this in parseComments.
 *
 * NOTE: this escape is only needed for the markdown appendix (HTML-comment fence).
 * The JSON export endpoint does NOT use it — JSON.stringify already escapes every
 * dangerous character for JSON output. Do not double-escape.
 */
export function serializeComments(content: string, threads: EmbeddedThread[]): string {
  const clean = stripComments(content).trimEnd();
  if (threads.length === 0) return clean + "\n";
  // Pretty-print BEFORE encode; encode handles the `--` a body might introduce.
  const payload = encodeCommentSafe(JSON.stringify({ version: COMMENTS_VERSION, threads }, null, 2));
  // Defense-in-depth: assert no literal `--` survived (dev-only; noop in production
  // since we just encoded all of them, but catch any future code-path mistake).
  if (process.env.NODE_ENV !== "production" && /--/.test(payload)) {
    throw new Error("BUG: encodeCommentSafe left a literal `--` in the appendix body");
  }
  return `${clean}\n\n<!-- ${COMMENTS_MARKER} v${COMMENTS_VERSION}\n${payload}\n-->\n`;
}

/**
 * Split a downloaded file into its clean markdown and the embedded threads.
 *
 * - No appendix present → returns `{ content, threads: [] }` (legitimate "no comments" file).
 * - Appendix present but malformed (bad JSON or wrong shape) → throws `CommentsParseError`.
 *   Callers must handle the error; swallowing it silently would cause data loss.
 */
export function parseComments(md: string): { content: string; threads: EmbeddedThread[] } {
  const match = BLOCK_RE.exec(md);
  const content = stripComments(md);
  if (!match) return { content, threads: [] };
  // The JSON sits between the marker line and the closing `-->`.
  const inner = match[0]
    .replace(/^\n*<!--[^\n]*\n/, "")
    .replace(/-->\s*$/, "")
    .trim();
  // Reverse the HTML-comment fence escape (no-op for old appendices without the marker byte).
  const decoded = decodeCommentSafe(inner);
  let parsed: { version?: unknown; threads?: unknown };
  try {
    parsed = JSON.parse(decoded) as { version?: unknown; threads?: unknown };
  } catch {
    throw new CommentsParseError();
  }
  if (parsed.version !== COMMENTS_VERSION || !Array.isArray(parsed.threads)) {
    throw new CommentsParseError();
  }
  return { content, threads: parsed.threads as EmbeddedThread[] };
}
