import { describe, it, expect } from "vitest";
import { createClient } from "./client";

describe("createClient", () => {
  it("builds an authorized client and strips trailing slash", () => {
    const c = createClient({ baseUrl: "https://md.jholec.com/api/", token: "pat_x" });
    expect(c.baseUrl).toBe("https://md.jholec.com/api");
    expect(c.headers.Authorization).toBe("Bearer pat_x");
    expect(c.headers["Content-Type"]).toBe("application/json");
  });

  it("rejects a plaintext http base URL for a remote host", () => {
    expect(() => createClient({ baseUrl: "http://md.jholec.com/api", token: "pat_x" })).toThrow(
      /https/,
    );
  });

  it("allows http only for loopback hosts", () => {
    expect(() =>
      createClient({ baseUrl: "http://localhost:3000/api", token: "pat_x" }),
    ).not.toThrow();
    expect(() =>
      createClient({ baseUrl: "http://127.0.0.1:3000/api", token: "pat_x" }),
    ).not.toThrow();
  });

  it("rejects a malformed base URL", () => {
    expect(() => createClient({ baseUrl: "not a url", token: "pat_x" })).toThrow(/Invalid base URL/);
  });
});
