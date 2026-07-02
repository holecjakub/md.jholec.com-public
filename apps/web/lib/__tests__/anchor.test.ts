// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { buildAnchor, relocateAnchor, rangeFromOffsets } from "../anchor";

/**
 * DOM-level tests for the anchoring glue. The pure offset/scoring logic is
 * covered in @md/core (anchor-match.test.ts); here we exercise Selection →
 * anchor and anchor → Range against real jsdom fixtures with [data-block-id].
 */

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

/** Make a selection over [start,end) of a single text node and return it. */
function selectText(textNode: Text, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("buildAnchor", () => {
  it("builds prefix/suffix for a mid-block selection", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    const t = document.createTextNode("The quick brown fox");
    p.appendChild(t);
    container.appendChild(p);

    const start = "The quick brown fox".indexOf("brown");
    const sel = selectText(t, start, start + "brown".length);
    const anchor = buildAnchor(sel, container);

    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("brown");
    expect(anchor!.prefix).toBe("The quick ");
    expect(anchor!.suffix).toBe(" fox");
    expect(anchor!.blockId).toBe("0");
  });

  it("empty prefix at block start", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "1");
    const t = document.createTextNode("Hello world");
    p.appendChild(t);
    container.appendChild(p);

    const sel = selectText(t, 0, 5);
    const anchor = buildAnchor(sel, container);
    expect(anchor!.prefix).toBe("");
    expect(anchor!.quote).toBe("Hello");
  });

  it("empty suffix at block end", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "2");
    const t = document.createTextNode("Hello world");
    p.appendChild(t);
    container.appendChild(p);

    const start = "Hello world".indexOf("world");
    const sel = selectText(t, start, start + "world".length);
    const anchor = buildAnchor(sel, container);
    expect(anchor!.suffix).toBe("");
  });

  it("truncates prefix/suffix to 32 chars", () => {
    const long = "a".repeat(100) + "QUOTE" + "b".repeat(100);
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "3");
    const t = document.createTextNode(long);
    p.appendChild(t);
    container.appendChild(p);

    const start = long.indexOf("QUOTE");
    const sel = selectText(t, start, start + "QUOTE".length);
    const anchor = buildAnchor(sel, container);
    expect(anchor!.prefix.length).toBe(32);
    expect(anchor!.suffix.length).toBe(32);
  });

  it("returns null for a collapsed selection", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    const t = document.createTextNode("text");
    p.appendChild(t);
    container.appendChild(p);
    const sel = selectText(t, 2, 2);
    expect(buildAnchor(sel, container)).toBeNull();
  });

  it("returns null when selection is outside the container", () => {
    const outside = document.createElement("p");
    outside.setAttribute("data-block-id", "0");
    const t = document.createTextNode("outside text");
    outside.appendChild(t);
    document.body.appendChild(outside);
    const sel = selectText(t, 0, 7);
    expect(buildAnchor(sel, container)).toBeNull();
  });

  it("disambiguates a repeated quote via the start offset", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    const t = document.createTextNode("cat and cat");
    p.appendChild(t);
    container.appendChild(p);

    const secondStart = "cat and cat".lastIndexOf("cat");
    const sel = selectText(t, secondStart, secondStart + 3);
    const anchor = buildAnchor(sel, container);
    expect(anchor!.quote).toBe("cat");
    expect(anchor!.prefix).toBe("cat and ");
  });
});

describe("relocateAnchor", () => {
  it("relocates an exact single match", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("alpha beta gamma"));
    container.appendChild(p);

    const res = relocateAnchor(
      { quote: "beta", prefix: "alpha ", suffix: " gamma", blockId: "0" },
      container,
    );
    expect(res.status).toBe("exact");
    if (res.status === "exact") expect(res.range.toString()).toBe("beta");
  });

  it("disambiguates a repeated quote via prefix/suffix", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("a black cat and a white cat"));
    container.appendChild(p);

    const res = relocateAnchor(
      { quote: "cat", prefix: "a white ", suffix: "", blockId: "0" },
      container,
    );
    expect(res.status).toBe("exact");
    if (res.status === "exact") {
      // The chosen "cat" must be the one preceded by "white".
      const before = res.range.startContainer.textContent!.slice(0, res.range.startOffset);
      expect(before.endsWith("white ")).toBe(true);
    }
  });

  it("falls back to block start when the quote is absent", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("totally different text"));
    container.appendChild(p);

    const res = relocateAnchor(
      { quote: "missing", prefix: "", suffix: "", blockId: "0" },
      container,
    );
    expect(res.status).toBe("block");
    if (res.status === "block") expect(res.range.collapsed).toBe(true);
  });

  it("returns orphaned when the block is gone", () => {
    const res = relocateAnchor(
      { quote: "anything", prefix: "", suffix: "", blockId: "999" },
      container,
    );
    expect(res.status).toBe("orphaned");
  });

  it("resolves a quote spanning inline children (multiple text nodes)", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("The "));
    const strong = document.createElement("strong");
    strong.appendChild(document.createTextNode("quick brown"));
    p.appendChild(strong);
    p.appendChild(document.createTextNode(" fox"));
    container.appendChild(p);

    const res = relocateAnchor(
      { quote: "quick brown fox", prefix: "The ", suffix: "", blockId: "0" },
      container,
    );
    expect(res.status).toBe("exact");
    if (res.status === "exact") expect(res.range.toString()).toBe("quick brown fox");
  });
});

describe("rangeFromOffsets", () => {
  it("maps offsets across inline children", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("one "));
    const em = document.createElement("em");
    em.appendChild(document.createTextNode("two"));
    p.appendChild(em);
    p.appendChild(document.createTextNode(" three"));
    container.appendChild(p);

    // "two three" → offsets 4..13 of "one two three"
    const range = rangeFromOffsets(p, 4, 13);
    expect(range.toString()).toBe("two three");
  });
});
