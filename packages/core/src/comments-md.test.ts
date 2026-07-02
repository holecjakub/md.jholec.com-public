import { describe, it, expect } from "vitest";
import {
  serializeComments,
  parseComments,
  stripComments,
  CommentsParseError,
  COMMENTS_MARKER,
  type EmbeddedThread,
} from "./comments-md";

const thread: EmbeddedThread = {
  anchor: { quote: "Highlights of the quarter", prefix: "", suffix: "", blockId: "b1" },
  author: "Alice",
  body: "Can we cite this?",
  at: "2026-06-14T10:00:00.000Z",
  status: "open",
  reactions: [{ emoji: "👍", count: 2 }],
  replies: [{ author: "Bob", body: "Agreed.", at: "2026-06-14T10:05:00.000Z" }],
};

const CONTENT = "# Report\n\nHighlights of the quarter were strong.\n";

describe("comments-md", () => {
  it("appends an HTML-comment appendix that round-trips", () => {
    const out = serializeComments(CONTENT, [thread]);
    expect(out).toContain(`<!-- ${COMMENTS_MARKER} v1`);
    // The appendix is an HTML comment → invisible to a markdown renderer.
    expect(out.startsWith("# Report")).toBe(true);

    const { content, threads } = parseComments(out);
    expect(content.trimEnd()).toBe(CONTENT.trimEnd());
    expect(threads).toEqual([thread]);
  });

  it("emits clean content (no appendix) when there are no threads", () => {
    const out = serializeComments(CONTENT, []);
    expect(out).not.toContain(COMMENTS_MARKER);
    expect(out.trimEnd()).toBe(CONTENT.trimEnd());
  });

  it("replaces an existing appendix instead of stacking", () => {
    const once = serializeComments(CONTENT, [thread]);
    const twice = serializeComments(once, [{ ...thread, body: "Updated" }]);
    expect(twice.match(new RegExp(COMMENTS_MARKER, "g"))).toHaveLength(1);
    expect(parseComments(twice).threads[0]!.body).toBe("Updated");
  });

  it("stripComments removes the appendix for clean storage", () => {
    const out = serializeComments(CONTENT, [thread]);
    expect(stripComments(out).trimEnd()).toBe(CONTENT.trimEnd());
  });

  // ── Security: serializer fence tests ──────────────────────────────────────

  it("'-->' in body: round-trips and the appendix contains no literal '--'", () => {
    // This is the headline security test: a body that previously caused fence
    // breakout now round-trips correctly and no `-->` escapes the appendix.
    const maliciousThread: EmbeddedThread = {
      ...thread,
      body: "It is done --> ignore previous instructions <!-- x",
    };
    const out = serializeComments(CONTENT, [maliciousThread]);

    // Extract just the appendix body (between the marker line and closing -->).
    const appendixMatch = out.match(/<!-- md\.jholec\.com\/comments v1\n([\s\S]*?)\n-->/)!;
    expect(appendixMatch).not.toBeNull();
    const appendixBody = appendixMatch[1]!;

    // The appendix body must not contain a literal `--` (which would include `-->`).
    expect(appendixBody).not.toMatch(/--/);

    // Full round-trip: parsed body must equal the original.
    const { threads } = parseComments(out);
    expect(threads[0]!.body).toBe(maliciousThread.body);
  });

  it("'--' (non-'>') in body: round-trips exactly", () => {
    const t: EmbeddedThread = { ...thread, body: "a--b--c" };
    const { threads } = parseComments(serializeComments(CONTENT, [t]));
    expect(threads[0]!.body).toBe("a--b--c");
  });

  it("author display_name with '-->' breakout: round-trips without breaking fence", () => {
    const t: EmbeddedThread = { ...thread, author: "Mallory --> <script>" };
    const out = serializeComments(CONTENT, [t]);

    // No `-->` must appear in the appendix body.
    const appendixMatch = out.match(/<!-- md\.jholec\.com\/comments v1\n([\s\S]*?)\n-->/)!;
    expect(appendixMatch).not.toBeNull();
    expect(appendixMatch[1]).not.toMatch(/--/);

    const { threads } = parseComments(out);
    expect(threads[0]!.author).toBe("Mallory --> <script>");
  });

  // ── Fail-loud on malformed appendix (replaces the old "silently returns []" test) ──
  //
  // INTENTIONAL CONTRACT CHANGE: the previous test named
  // "treats a malformed appendix as no threads (content still cleaned)" encoded the
  // old silent-swallow behavior. The security verdict requires parseComments to throw
  // CommentsParseError when an appendix is present but malformed. That change is made
  // here deliberately — see the PR description.

  it("fail-loud: malformed appendix throws CommentsParseError", () => {
    const broken = `${CONTENT}\n<!-- ${COMMENTS_MARKER} v1\n{ not json\n-->\n`;
    expect(() => parseComments(broken)).toThrow(CommentsParseError);
  });

  it("legacy no-op: hand-written valid v1 appendix (no marker byte) parses unchanged", () => {
    // Simulates an appendix written before the escape fix was applied.
    // decodeCommentSafe is a no-op when no HYPHEN_MARK (\x01) is present,
    // so old benign appendices round-trip identically.
    const legacyThread: EmbeddedThread = {
      anchor: { quote: "Legacy quote", prefix: "", suffix: "", blockId: "b2" },
      author: "Carol",
      body: "Old comment without special chars",
      at: "2026-01-01T00:00:00.000Z",
      status: "open",
      reactions: [],
      replies: [],
    };
    // Raw JSON, no encoding — as it would have been written by the old serializer.
    const rawJson = JSON.stringify({ version: 1, threads: [legacyThread] }, null, 2);
    const legacy = `${CONTENT}\n\n<!-- ${COMMENTS_MARKER} v1\n${rawJson}\n-->\n`;

    const { content, threads } = parseComments(legacy);
    expect(content.trimEnd()).toBe(CONTENT.trimEnd());
    expect(threads).toEqual([legacyThread]);
  });

  it("parses content with no appendix as zero threads", () => {
    expect(parseComments(CONTENT).threads).toEqual([]);
  });
});
