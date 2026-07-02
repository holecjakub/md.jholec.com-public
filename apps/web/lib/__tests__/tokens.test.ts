import { describe, it, expect } from "vitest";
import { sha256hex, generateToken, constantTimeEqualHex } from "../crypto/tokens";

describe("tokens", () => {
  it("sha256hex is deterministic and 64 hex chars", () => {
    const h = sha256hex("hello");
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(sha256hex("hello")).toBe(h);
  });

  it("generateToken returns 256-bit base64url (43 chars, no padding)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t).not.toBe(generateToken());
  });

  it("constantTimeEqualHex matches equal, rejects different and bad-length", () => {
    const a = sha256hex("x");
    expect(constantTimeEqualHex(a, a)).toBe(true);
    expect(constantTimeEqualHex(a, sha256hex("y"))).toBe(false);
    expect(constantTimeEqualHex(a, "abc")).toBe(false);
  });
});
