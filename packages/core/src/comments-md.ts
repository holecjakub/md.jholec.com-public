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

const MARKER_PATTERN = COMMENTS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The appendix body must never cross an inner `-->`. encodeCommentSafe guarantees
// a machine-written appendix contains no `--` at all, so this guard can never
// reject a real appendix — but without it a mid-file mention of the marker plus
// ANY later `-->` in the file made the lazy body swallow everything in between,
// and stripComments silently deleted that content on every upload / `md push`.
const BLOCK_BODY = "(?:(?!-->)[\\s\\S])*?";

// A well-formed appendix block (and any trailing whitespace) anchored at the end
// of the file — the only thing serializeComments ever writes.
const BLOCK_RE = new RegExp(`\\n*<!--\\s*${MARKER_PATTERN}\\s+v\\d+${BLOCK_BODY}-->\\s*$`);

// The appendix opener, anywhere in the file (global, to find the LAST occurrence).
const OPENER_RE = new RegExp(`<!--\\s*${MARKER_PATTERN}\\s+v\\d+`, "g");

// A closed appendix-shaped block starting at an exact offset (sticky).
const CLOSED_BLOCK_AT_RE = new RegExp(`<!--\\s*${MARKER_PATTERN}\\s+v\\d+${BLOCK_BODY}-->`, "y");

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
// containing a raw U+0001 byte emits the six-char text sequence \u0001, NOT the raw
// byte — so a malicious body that happens to contain a literal U+0001 is already
// represented as the text \u0001 in the JSON output. Our encode step, which scans
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

/** Index of the last appendix opener in `md`, or -1 when the marker never appears. */
function lastOpenerIndex(md: string): number {
  let last = -1;
  OPENER_RE.lastIndex = 0;
  for (let m = OPENER_RE.exec(md); m !== null; m = OPENER_RE.exec(md)) last = m.index;
  return last;
}

/** Extract the payload between the opener line and the closing `-->`. */
function appendixInner(block: string): string {
  return block
    .replace(/^\n*<!--[^\n]*\n/, "")
    .replace(/-->\s*$/, "")
    .trim();
}

/**
 * Decode + parse an appendix payload. Returns the threads on success, null when
 * the payload is not a valid v1 comments document. Used both to parse the EOF
 * appendix (null → CommentsParseError there) and to decide whether a marker
 * block that is NOT at EOF is a real machine-written appendix or just content
 * that happens to mention the marker.
 */
function tryParsePayload(inner: string): EmbeddedThread[] | null {
  const decoded = decodeCommentSafe(inner);
  let parsed: { version?: unknown; threads?: unknown };
  try {
    parsed = JSON.parse(decoded) as { version?: unknown; threads?: unknown };
  } catch {
    return null;
  }
  if (parsed.version !== COMMENTS_VERSION || !Array.isArray(parsed.threads)) return null;
  return parsed.threads as EmbeddedThread[];
}

/**
 * A real appendix that is NOT at end-of-file (e.g. someone appended a line after
 * `md pull`). Returns the block's [start, end) offsets, or null when the last
 * marker occurrence is not a parseable appendix (then it is ordinary content).
 */
function misplacedAppendix(md: string): { start: number; end: number } | null {
  const start = lastOpenerIndex(md);
  if (start === -1) return null;
  CLOSED_BLOCK_AT_RE.lastIndex = start;
  const block = CLOSED_BLOCK_AT_RE.exec(md);
  if (!block || tryParsePayload(appendixInner(block[0])) === null) return null;
  return { start, end: start + block[0].length };
}

/**
 * Remove any embedded comments appendix, returning clean markdown.
 *
 * Only the trailing (end-of-file) appendix block is stripped; content that merely
 * mentions the marker (e.g. a document describing this very format) is left
 * untouched. Defensive recovery: when a real, parseable appendix is followed by a
 * trailer (a line someone appended after `md pull`), the appendix block is still
 * removed and the trailer kept — the comment JSON (author names, bodies) must
 * never be stored as document content.
 */
export function stripComments(md: string): string {
  const eof = BLOCK_RE.exec(md);
  if (eof) return md.slice(0, eof.index).trimEnd() + "\n";
  const misplaced = misplacedAppendix(md);
  if (misplaced) {
    const before = md.slice(0, misplaced.start).trimEnd();
    const after = md.slice(misplaced.end).trim();
    return [before, after].filter(Boolean).join("\n\n") + "\n";
  }
  return md.trimEnd() + "\n";
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
 * - A real (parseable) appendix that is not at end-of-file — e.g. a trailer line was
 *   appended after `md pull` — also throws `CommentsParseError` instead of silently
 *   returning zero threads with the appendix JSON still inside `content`.
 */
export function parseComments(md: string): { content: string; threads: EmbeddedThread[] } {
  const match = BLOCK_RE.exec(md);
  if (!match) {
    // Fail-loud: a parseable appendix that is not the EOF appendix must not be
    // silently returned as content with zero threads.
    if (misplacedAppendix(md)) throw new CommentsParseError();
    return { content: md.trimEnd() + "\n", threads: [] };
  }
  const content = md.slice(0, match.index).trimEnd() + "\n";
  // The JSON sits between the marker line and the closing `-->`; decodeCommentSafe
  // reverses the fence escape (no-op for old appendices without the marker byte).
  const threads = tryParsePayload(appendixInner(match[0]));
  if (threads === null) throw new CommentsParseError();
  return { content, threads };
}
