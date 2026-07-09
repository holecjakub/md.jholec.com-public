import { describe, it, expect, vi, beforeEach } from "vitest";

// The limiter reaches the DB only through admin(); stub it so each test can dictate
// what the record_auth_attempt RPC (or the pre-0010 fallback) returns.
const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("../db/admin", () => ({
  admin: () => ({ rpc: rpcMock, from: fromMock }),
}));

import { isRateLimited, isIpRateLimited } from "../auth/rate-limit";

/**
 * Guards the audit-3.7 threshold invariant: recordAttempt returns the window count
 * INCLUDING the attempt just recorded, and the `count > LIMIT` comparison therefore
 * allows exactly LIMIT attempts per window — attempt LIMIT+1 is the first blocked.
 * (Documented budgets: password/early_access 10, redeem 20, export 30, write 60;
 * e2e/rate-limit-hardening.spec.ts pins the same semantics end-to-end.)
 */
describe("rate-limit thresholds", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
  });

  it("password: the 10th attempt in the window is still allowed", async () => {
    rpcMock.mockResolvedValue({ data: 10, error: null }); // inclusive of this attempt
    expect(await isRateLimited("doc-1", "203.0.113.7")).toBe(false);
  });

  it("password: the 11th attempt in the window is blocked", async () => {
    rpcMock.mockResolvedValue({ data: 11, error: null });
    expect(await isRateLimited("doc-1", "203.0.113.7")).toBe(true);
  });

  it("redeem: the 20th attempt is allowed, the 21st is blocked", async () => {
    rpcMock.mockResolvedValueOnce({ data: 20, error: null });
    expect(await isIpRateLimited("203.0.113.7", "redeem")).toBe(false);
    rpcMock.mockResolvedValueOnce({ data: 21, error: null });
    expect(await isIpRateLimited("203.0.113.7", "redeem")).toBe(true);
  });

  it("passes the attempt to the RPC with the right scope and key", async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });
    await isIpRateLimited("203.0.113.7", "export");
    expect(rpcMock).toHaveBeenCalledWith(
      "record_auth_attempt",
      expect.objectContaining({ p_document_id: null, p_ip: "203.0.113.7", p_scope: "export" }),
    );
  });

  it("fails open (not limited) when the RPC errors for a non-missing-function reason", async () => {
    // Deliberate security decision: an unrelated DB failure must not lock users out.
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await isIpRateLimited("203.0.113.7", "write")).toBe(false);
    consoleErr.mockRestore();
  });

  it("pre-0010 fallback keeps the same inclusive-count threshold", async () => {
    // RPC missing (migration not applied) → INSERT-then-COUNT fallback path.
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });

    const makeCountChain = (count: number) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "is"]) {
        chain[m] = vi.fn(() => chain);
      }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ count, error: null }).then(resolve);
      return chain;
    };

    // First from() call: the INSERT; second: the COUNT chain (inclusive of the insert).
    fromMock
      .mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ error: null }) })
      .mockReturnValueOnce(makeCountChain(20))
      .mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ error: null }) })
      .mockReturnValueOnce(makeCountChain(21));

    expect(await isIpRateLimited("203.0.113.7", "redeem")).toBe(false);
    expect(await isIpRateLimited("203.0.113.7", "redeem")).toBe(true);
  });
});
