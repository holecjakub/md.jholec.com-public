import { describe, it, expect } from "vitest";
import {
  PREFIX_LEN,
  SUFFIX_LEN,
  contextWindows,
  allOccurrences,
  findBestQuoteMatch,
} from "./anchor-match";

describe("contextWindows", () => {
  it("returns prefix/suffix around a mid-block quote", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const start = text.indexOf("brown");
    const end = start + "brown".length;
    const { prefix, suffix } = contextWindows(text, start, end);
    expect(prefix).toBe("The quick ");
    expect(suffix).toBe(" fox jumps over the lazy dog");
  });

  it("empty prefix at block start", () => {
    const text = "Hello world";
    const { prefix, suffix } = contextWindows(text, 0, 5);
    expect(prefix).toBe("");
    expect(suffix).toBe(" world");
  });

  it("empty suffix at block end", () => {
    const text = "Hello world";
    const start = text.indexOf("world");
    const { prefix, suffix } = contextWindows(text, start, text.length);
    expect(prefix).toBe("Hello ");
    expect(suffix).toBe("");
  });

  it("truncates prefix/suffix to the configured window length", () => {
    const before = "a".repeat(100);
    const after = "b".repeat(100);
    const text = `${before}QUOTE${after}`;
    const start = before.length;
    const end = start + "QUOTE".length;
    const { prefix, suffix } = contextWindows(text, start, end);
    expect(prefix.length).toBe(PREFIX_LEN);
    expect(suffix.length).toBe(SUFFIX_LEN);
    expect(prefix).toBe("a".repeat(PREFIX_LEN));
    expect(suffix).toBe("b".repeat(SUFFIX_LEN));
  });
});

describe("allOccurrences", () => {
  it("finds every non-overlapping index", () => {
    expect(allOccurrences("ababab", "ab")).toEqual([0, 2, 4]);
  });
  it("returns empty for an empty needle", () => {
    expect(allOccurrences("abc", "")).toEqual([]);
  });
  it("returns empty when absent", () => {
    expect(allOccurrences("abc", "z")).toEqual([]);
  });
});

describe("findBestQuoteMatch", () => {
  it("returns null when the quote is absent", () => {
    expect(
      findBestQuoteMatch("nothing here", { quote: "missing", prefix: "", suffix: "" }),
    ).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(findBestQuoteMatch("abc", { quote: "", prefix: "", suffix: "" })).toBeNull();
  });

  it("matches a unique occurrence", () => {
    const text = "alpha beta gamma";
    const m = findBestQuoteMatch(text, { quote: "beta", prefix: "alpha ", suffix: " gamma" });
    expect(m).not.toBeNull();
    expect(m!.via).toBe("unique");
    expect(text.slice(m!.start, m!.end)).toBe("beta");
  });

  it("disambiguates repeated quote by prefix", () => {
    // "cat" appears twice; recorded prefix points at the SECOND one.
    const text = "a black cat and a white cat";
    const secondStart = text.lastIndexOf("cat");
    const m = findBestQuoteMatch(text, {
      quote: "cat",
      prefix: "a white ",
      suffix: "",
    });
    expect(m).not.toBeNull();
    expect(m!.via).toBe("context");
    expect(m!.start).toBe(secondStart);
  });

  it("disambiguates repeated quote by suffix", () => {
    const text = "run fast then run slow";
    const firstStart = text.indexOf("run");
    const m = findBestQuoteMatch(text, {
      quote: "run",
      prefix: "",
      suffix: " fast",
    });
    expect(m).not.toBeNull();
    expect(m!.start).toBe(firstStart);
  });

  it("falls back to the earliest occurrence on a context tie", () => {
    const text = "xx yy xx yy";
    const m = findBestQuoteMatch(text, { quote: "xx", prefix: "ZZZ", suffix: "ZZZ" });
    expect(m).not.toBeNull();
    expect(m!.start).toBe(0);
  });
});
