import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../crypto/password";

describe("password (argon2id)", () => {
  it("hashes to an argon2id encoded string and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});
