import { describe, it, expect } from "vitest";
import { createClient } from "./client";

describe("createClient", () => {
  it("builds an authorized client and strips trailing slash", () => {
    const c = createClient({ baseUrl: "https://md.jholec.com/api/", token: "pat_x" });
    expect(c.baseUrl).toBe("https://md.jholec.com/api");
    expect(c.headers.Authorization).toBe("Bearer pat_x");
    expect(c.headers["Content-Type"]).toBe("application/json");
  });
});
