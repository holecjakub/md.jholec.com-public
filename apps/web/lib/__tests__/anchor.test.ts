// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildAnchor,
  buildBlockAnchor,
  createRelocationCache,
  relocateAnchor,
  rangeFromOffsets,
} from "../anchor";

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

  it("returns null for a selection spanning two blocks", () => {
    const p1 = document.createElement("p");
    p1.setAttribute("data-block-id", "0");
    const t1 = document.createTextNode("First paragraph text");
    p1.appendChild(t1);
    const p2 = document.createElement("p");
    p2.setAttribute("data-block-id", "1");
    const t2 = document.createTextNode("Second paragraph text");
    p2.appendChild(t2);
    container.append(p1, p2);

    // Mid-paragraph-1 → mid-paragraph-2: the concatenated quote exists in
    // neither block, so no anchor can be built.
    const range = document.createRange();
    range.setStart(t1, "First ".length);
    range.setEnd(t2, "Second".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(sel.toString()).toContain("paragraph");
    expect(buildAnchor(sel, container)).toBeNull();
  });

  it("still builds an anchor for a within-block selection when siblings exist", () => {
    const p1 = document.createElement("p");
    p1.setAttribute("data-block-id", "0");
    const t1 = document.createTextNode("First paragraph text");
    p1.appendChild(t1);
    const p2 = document.createElement("p");
    p2.setAttribute("data-block-id", "1");
    p2.appendChild(document.createTextNode("Second paragraph text"));
    container.append(p1, p2);

    const start = "First paragraph text".indexOf("paragraph");
    const sel = selectText(t1, start, start + "paragraph".length);
    const anchor = buildAnchor(sel, container);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("paragraph");
    expect(anchor!.blockId).toBe("0");
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

describe("buildBlockAnchor", () => {
  it("anchors a whole block with empty prefix and relocates exactly", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "3");
    p.appendChild(document.createTextNode("A short paragraph to comment on."));
    container.appendChild(p);

    const anchor = buildBlockAnchor(p);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("A short paragraph to comment on.");
    expect(anchor!.prefix).toBe("");
    expect(anchor!.suffix).toBe("");
    expect(anchor!.blockId).toBe("3");

    const result = relocateAnchor(anchor!, container);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.range.toString()).toBe("A short paragraph to comment on.");
    }
  });

  it("clamps the quote of an oversized block under the server cap, keeping a suffix", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "4");
    p.appendChild(document.createTextNode(`${"x".repeat(2500)} tail`));
    container.appendChild(p);

    const anchor = buildBlockAnchor(p);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote.length).toBe(2000);
    expect(anchor!.suffix.length).toBeGreaterThan(0);

    const result = relocateAnchor(anchor!, container);
    expect(result.status).toBe("exact");
  });

  it("returns null for a block with no text (e.g. an hr)", () => {
    const hr = document.createElement("hr");
    hr.setAttribute("data-block-id", "5");
    container.appendChild(hr);
    expect(buildBlockAnchor(hr)).toBeNull();
  });

  it("returns null for an element without data-block-id", () => {
    const p = document.createElement("p");
    p.appendChild(document.createTextNode("orphan"));
    container.appendChild(p);
    expect(buildBlockAnchor(p)).toBeNull();
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

  it("falls back to block start when a repeated quote has no context agreement", () => {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", "0");
    p.appendChild(document.createTextNode("a cat and a cat"));
    container.appendChild(p);

    // Both "cat"s score zero against the recorded context — highlighting one
    // would be a guess, so the anchor degrades instead.
    const res = relocateAnchor(
      { quote: "cat", prefix: "XXX", suffix: "YYY", blockId: "0" },
      container,
    );
    expect(res.status).toBe("block");
    if (res.status === "block") expect(res.range.collapsed).toBe(true);
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

describe("createRelocationCache", () => {
  const betaAnchor = { quote: "beta", prefix: "alpha ", suffix: " gamma", blockId: "0" };

  function addBlock(text = "alpha beta gamma", blockId = "0"): HTMLElement {
    const p = document.createElement("p");
    p.setAttribute("data-block-id", blockId);
    p.appendChild(document.createTextNode(text));
    container.appendChild(p);
    return p;
  }

  it("reuses a resolved result across passes while the DOM is unchanged", () => {
    addBlock();
    const cache = createRelocationCache(container);

    const r1 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r1.status).toBe("exact");

    // A later pass with a value-equal (but distinct) anchor object — as a
    // refetched row carries — must return the SAME cached result object.
    const r2 = cache.beginPass(new Set(["t1"])).resolve("t1", { ...betaAnchor });
    expect(r2).toBe(r1);
    if (r2.status === "exact") expect(r2.range.toString()).toBe("beta");
  });

  it("recomputes when the block text changes", () => {
    const p = addBlock();
    const cache = createRelocationCache(container);
    const r1 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r1.status).toBe("exact");

    p.firstChild!.textContent = "alpha delta gamma";
    const r2 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r2).not.toBe(r1);
    expect(r2.status).toBe("block");
  });

  it("revalidates a Range whose text nodes were replaced (same flattened text)", () => {
    const p = addBlock();
    const cache = createRelocationCache(container);
    const r1 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r1.status).toBe("exact");
    if (r1.status !== "exact") return;

    // Simulate a preview re-render / highlight strip+normalize: the flattened
    // block text is byte-identical, but the node the cached Range points into
    // is gone, so the Range collapses. The cache must catch this via the
    // range.toString() === quote validity check and re-resolve.
    p.replaceChildren(document.createTextNode("alpha beta gamma"));
    expect(r1.range.toString()).not.toBe("beta");

    const r2 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r2).not.toBe(r1);
    expect(r2.status).toBe("exact");
    if (r2.status === "exact") expect(r2.range.toString()).toBe("beta");
  });

  it("tracks a block appearing after an orphaned resolution", () => {
    const cache = createRelocationCache(container);
    const r1 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r1.status).toBe("orphaned");
    // Orphaned results stay cached while the block is absent…
    expect(cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor)).toBe(r1);

    // …and recompute once the block exists.
    addBlock();
    const r2 = cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor);
    expect(r2.status).toBe("exact");
  });

  it("refresh force-recomputes and replaces the cache entry", () => {
    addBlock();
    const cache = createRelocationCache(container);
    const pass = cache.beginPass(new Set(["t1"]));
    const r1 = pass.resolve("t1", betaAnchor);
    const r2 = pass.refresh("t1", betaAnchor);
    expect(r2).not.toBe(r1);
    // The refreshed result is what later resolves return.
    expect(cache.beginPass(new Set(["t1"])).resolve("t1", betaAnchor)).toBe(r2);
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
