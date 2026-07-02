import { describe, it, expect, beforeAll } from "vitest";
import { signSession, verifySession, type SessionClaims } from "../auth/session";

const SECRET = "test-secret-test-secret-test-secret-0123";
beforeAll(() => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.SESSION_TTL_SECONDS = "3600";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "x";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
});

const claims: SessionClaims = { doc: "doc-1", pid: "p-1", role: "reviewer" };

describe("session", () => {
  it("signs and verifies a round-trip", async () => {
    const token = await signSession(claims);
    const out = await verifySession(token);
    expect(out?.doc).toBe("doc-1");
    expect(out?.pid).toBe("p-1");
    expect(out?.role).toBe("reviewer");
  });

  it("rejects a tampered token", async () => {
    const token = await signSession(claims);
    expect(await verifySession(token + "x")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSession(claims, -10); // already expired
    expect(await verifySession(token)).toBeNull();
  });
});
