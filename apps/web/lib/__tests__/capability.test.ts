import { describe, it, expect } from "vitest";
import { evaluateAccessToken, type AccessTokenRow } from "../capability";

const base: AccessTokenRow = {
  document_id: "doc-1",
  kind: "invite",
  reusable: false,
  consumed_at: null,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  revoked_at: null,
};
const now = () => new Date();

describe("evaluateAccessToken", () => {
  it("accepts a valid single-use invite for the right doc", () => {
    expect(evaluateAccessToken(base, "doc-1", now()).ok).toBe(true);
  });
  it("rejects when document mismatches", () => {
    expect(evaluateAccessToken(base, "doc-2", now())).toMatchObject({ ok: false, reason: "wrong_doc" });
  });
  it("rejects an expired token", () => {
    const t = { ...base, expires_at: new Date(Date.now() - 1000).toISOString() };
    expect(evaluateAccessToken(t, "doc-1", now())).toMatchObject({ ok: false, reason: "expired" });
  });
  it("rejects a revoked token", () => {
    const t = { ...base, revoked_at: new Date(Date.now() - 1000).toISOString() };
    expect(evaluateAccessToken(t, "doc-1", now())).toMatchObject({ ok: false, reason: "revoked" });
  });
  it("rejects a consumed single-use token", () => {
    const t = { ...base, consumed_at: new Date(Date.now() - 1000).toISOString() };
    expect(evaluateAccessToken(t, "doc-1", now())).toMatchObject({ ok: false, reason: "consumed" });
  });
  it("accepts a consumed REUSABLE token", () => {
    const t = { ...base, reusable: true, consumed_at: new Date(Date.now() - 1000).toISOString() };
    expect(evaluateAccessToken(t, "doc-1", now()).ok).toBe(true);
  });
});
