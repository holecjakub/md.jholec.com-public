// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { buildAnchor, relocateAnchor, type TextQuoteAnchor } from "../anchor";

/**
 * Cross-version anchoring (audit gap 2.1).
 *
 * Blocks carry a POSITIONAL, sequential `data-block-id` (0,1,2,… top-to-bottom,
 * stamped by MarkdownPreview). A `md push` that inserts or removes a block ABOVE
 * an anchored one therefore re-numbers every block below it: the anchor's stored
 * blockId now points at a DIFFERENT block in the new version.
 *
 * relocateAnchor resolves an anchor within the single block matching its stored
 * id. The contract this suite guards: across such a version shift it either
 *   - resolves EXACTLY (the block at that id still holds the quote), or
 *   - DEGRADES to a block-start / orphaned fallback,
 * but NEVER silently reports an exact highlight over unrelated text.
 */

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

/**
 * Render a document version: one <p data-block-id="i"> per paragraph, matching
 * the positional ids MarkdownPreview stamps. Returns the container.
 */
function renderVersion(paragraphs: string[]): void {
  container.innerHTML = "";
  paragraphs.forEach((text, i) => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", String(i));
    p.appendChild(document.createTextNode(text));
    container.appendChild(p);
  });
}

/** Build an anchor over the first occurrence of `quote` in block `blockId`. */
function anchorFor(blockId: string, quote: string): TextQuoteAnchor {
  const block = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)!;
  const textNode = block.firstChild as Text;
  const start = textNode.textContent!.indexOf(quote);
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + quote.length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const anchor = buildAnchor(sel, container);
  expect(anchor, "fixture: anchor must build").not.toBeNull();
  return anchor!;
}

describe("cross-version anchoring — block inserted above the anchor", () => {
  it("degrades instead of anchoring to unrelated text when ids shift up", () => {
    // V1: the launch date lives in block 1.
    renderVersion(["Intro paragraph one.", "The launch date is May 5th.", "Closing remarks."]);
    const anchor = anchorFor("1", "May 5th");
    expect(anchor.blockId).toBe("1");

    // V2: a banner block is inserted at the top → every block below shifts up by
    // one. Block 1 is now the (unrelated) intro; the quote lives in block 2.
    renderVersion([
      "NEW: launch delayed.",
      "Intro paragraph one.",
      "The launch date is May 5th.",
      "Closing remarks.",
    ]);

    const res = relocateAnchor(anchor, container);
    // The block at the stored id no longer contains the quote → must degrade,
    // never claim an exact highlight, and never point at the wrong block's text.
    expect(res.status).not.toBe("exact");
    if (res.status === "block") {
      expect(res.range.toString()).toBe(""); // collapsed at block start
      expect(res.block.getAttribute("data-block-id")).toBe("1");
    }
  });
});

describe("cross-version anchoring — block removed above the anchor", () => {
  it("degrades gracefully when ids shift down onto an unrelated block", () => {
    // V1: quote in block 2.
    renderVersion(["Header.", "Intro paragraph.", "Ship it on Friday at noon.", "Footer."]);
    const anchor = anchorFor("2", "Friday at noon");

    // V2: the header block is removed → the quote's paragraph is now block 1,
    // and block 2 is the (unrelated) footer.
    renderVersion(["Intro paragraph.", "Ship it on Friday at noon.", "Footer."]);

    const res = relocateAnchor(anchor, container);
    expect(res.status).not.toBe("exact");
    // Whatever the fallback, it must not fabricate the quote out of unrelated text.
    if (res.status === "block") {
      expect(res.range.toString()).toBe("");
    }
  });
});

describe("cross-version anchoring — positive cases the layer must still resolve", () => {
  it("resolves EXACTLY when a block is inserted BELOW the anchor (ids preserved)", () => {
    renderVersion(["The API returns a 201 on success.", "See the appendix."]);
    const anchor = anchorFor("0", "201 on success");

    // Insert content below the anchored block; block 0's id is unchanged.
    renderVersion([
      "The API returns a 201 on success.",
      "See the appendix.",
      "Newly appended section.",
    ]);

    const res = relocateAnchor(anchor, container);
    expect(res.status).toBe("exact");
    expect(res.status === "exact" && res.range.toString()).toBe("201 on success");
  });

  it("resolves EXACTLY when the anchored block is edited but the quote survives", () => {
    renderVersion(["Please review the migration plan before Monday.", "Thanks."]);
    const anchor = anchorFor("0", "migration plan");

    // Same block id, surrounding words edited, quote intact.
    renderVersion(["Team: kindly review the migration plan ASAP.", "Thanks."]);

    const res = relocateAnchor(anchor, container);
    expect(res.status).toBe("exact");
    expect(res.status === "exact" && res.range.toString()).toBe("migration plan");
  });

  it("degrades (never mis-anchors) when the quote is deleted from its block", () => {
    renderVersion(["The secret code is HUNTER2 — keep it safe.", "End."]);
    const anchor = anchorFor("0", "HUNTER2");

    // Same block id, quote removed entirely.
    renderVersion(["The secret code was rotated — keep it safe.", "End."]);

    const res = relocateAnchor(anchor, container);
    expect(res.status).toBe("block");
    if (res.status === "block") expect(res.range.toString()).toBe("");
  });
});
