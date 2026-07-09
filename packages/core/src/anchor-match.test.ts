import { describe, it, expect } from "vitest";
import {
  PREFIX_LEN,
  SUFFIX_LEN,
  contextWindows,
  allOccurrences,
  findBestQuoteMatch,
} from "./anchor-match";

/** ES2022 lib has no typings for String.prototype.isWellFormed; runtime (Node 20+) does. */
const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();

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

  it("does not split a surrogate pair at the prefix window edge", () => {
    // "😀" occupies indices 0..1; the 32-unit window would start at index 1,
    // right on the low surrogate. The window must snap past it.
    const text = `😀${"a".repeat(31)}QUOTE`;
    const start = text.indexOf("QUOTE");
    const { prefix } = contextWindows(text, start, start + "QUOTE".length);
    expect(isWellFormed(prefix)).toBe(true);
    expect(prefix).toBe("a".repeat(31));
  });

  it("does not split a surrogate pair at the suffix window edge", () => {
    // The emoji's high surrogate sits exactly at end + SUFFIX_LEN - 1; the
    // window must snap back before it.
    const text = `QUOTE${"b".repeat(SUFFIX_LEN - 1)}😀x`;
    const { suffix } = contextWindows(text, 0, "QUOTE".length);
    expect(isWellFormed(suffix)).toBe(true);
    expect(suffix).toBe("b".repeat(SUFFIX_LEN - 1));
  });

  it("keeps an emoji fully inside the window intact", () => {
    const text = `a😀b QUOTE c😀d`;
    const start = text.indexOf("QUOTE");
    const { prefix, suffix } = contextWindows(text, start, start + "QUOTE".length);
    expect(isWellFormed(prefix)).toBe(true);
    expect(isWellFormed(suffix)).toBe(true);
    expect(prefix).toBe("a😀b ");
    expect(suffix).toBe(" c😀d");
  });
});

describe("allOccurrences", () => {
  it("finds every index", () => {
    expect(allOccurrences("ababab", "ab")).toEqual([0, 2, 4]);
  });
  it("finds overlapping occurrences", () => {
    expect(allOccurrences("1.1.1", "1.1")).toEqual([0, 2]);
    expect(allOccurrences("aaa", "aa")).toEqual([0, 1]);
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

  it("finds the second of two OVERLAPPING occurrences via context", () => {
    // "1.1" occurs at 12 and (overlapping) at 14 in "See section 1.1.1";
    // the recorded prefix points at the second one.
    const text = "See section 1.1.1";
    const m = findBestQuoteMatch(text, {
      quote: "1.1",
      prefix: "See section 1.",
      suffix: "",
    });
    expect(m).not.toBeNull();
    expect(m!.start).toBe(14);
    expect(m!.via).toBe("context");
  });

  it("does not label an overlapping duplicate as unique", () => {
    // "aa" occurs at 0 and (overlapping) at 1 in "aaa" — the suffix picks 0,
    // but it must be a context decision, never a confident "unique".
    const m = findBestQuoteMatch("aaa", { quote: "aa", prefix: "", suffix: "a" });
    expect(m).not.toBeNull();
    expect(m!.via).toBe("context");
    expect(m!.start).toBe(0);
  });

  it("flags indistinguishable occurrences as ambiguous instead of guessing", () => {
    // Two occurrences, zero agreement with the recorded context: any pick is
    // a guess, so the match is flagged for the caller to degrade.
    const text = "a cat and a cat";
    const m = findBestQuoteMatch(text, { quote: "cat", prefix: "XXX", suffix: "YYY" });
    expect(m).not.toBeNull();
    expect(m!.via).toBe("ambiguous");
    expect(m!.start).toBe(2);
  });
});
