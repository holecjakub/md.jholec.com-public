import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, createClient } from "@md/core";
import {
  DEFAULT_API_URL,
  UPLOAD_LOCKED_MESSAGE,
  configPaths,
  loadConfig,
  mapPushError,
  resolveAnonToken,
  resolveAuthToken,
  resolveBaseUrl,
  saveConfig,
  type Config,
} from "./config";

/** Build a process-env-shaped object for the pure resolvers. */
function env(vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("resolveBaseUrl precedence", () => {
  it("prefers MD_API_URL over config and default", () => {
    expect(
      resolveBaseUrl(env({ MD_API_URL: "https://env.example/api" }), {
        apiUrl: "https://cfg.example/api",
      }),
    ).toBe("https://env.example/api");
  });

  it("falls back to config when the env var is absent", () => {
    expect(resolveBaseUrl(env(), { apiUrl: "https://cfg.example/api" })).toBe(
      "https://cfg.example/api",
    );
  });

  it("falls back to the hosted default when neither is set", () => {
    expect(resolveBaseUrl(env(), {})).toBe(DEFAULT_API_URL);
    expect(DEFAULT_API_URL).toBe("https://md.jholec.com/api");
  });
});

describe("base URL security (via createClient, which the CLI feeds resolveBaseUrl into)", () => {
  it("rejects a plaintext http:// base URL for a non-loopback host", () => {
    const baseUrl = resolveBaseUrl(env({ MD_API_URL: "http://evil.example/api" }), {});
    expect(() => createClient({ baseUrl, token: "pat_x" })).toThrow(/Refusing to send/i);
  });

  it("accepts https:// and http://localhost", () => {
    expect(() =>
      createClient({ baseUrl: resolveBaseUrl(env({ MD_API_URL: "https://ok.example" }), {}), token: "t" }),
    ).not.toThrow();
    expect(() =>
      createClient({ baseUrl: resolveBaseUrl(env({ MD_API_URL: "http://localhost:3000/api" }), {}), token: "t" }),
    ).not.toThrow();
  });
});

describe("token resolution (anon vs authed client selection)", () => {
  it("authed token prefers MD_TOKEN, then config, else undefined", () => {
    expect(resolveAuthToken(env({ MD_TOKEN: "pat_env" }), { token: "pat_cfg" })).toBe("pat_env");
    expect(resolveAuthToken(env(), { token: "pat_cfg" })).toBe("pat_cfg");
    expect(resolveAuthToken(env(), {})).toBeUndefined();
  });

  it("anon token falls back to the \"none\" sentinel when unauthenticated", () => {
    expect(resolveAnonToken(env({ MD_TOKEN: "pat_env" }), {})).toBe("pat_env");
    expect(resolveAnonToken(env(), { token: "pat_cfg" })).toBe("pat_cfg");
    expect(resolveAnonToken(env(), {})).toBe("none");
  });
});

describe("mapPushError (403 → 'Upload is locked' remap)", () => {
  it("remaps a 403 to the actionable unlock hint", () => {
    expect(mapPushError(new ApiError(403, "Forbidden"))).toBe(UPLOAD_LOCKED_MESSAGE);
  });

  it("keeps the status for other API errors", () => {
    expect(mapPushError(new ApiError(500, "boom"))).toBe("Error 500: boom");
  });

  it("stringifies non-API errors", () => {
    expect(mapPushError(new Error("network down"))).toBe("network down");
    expect(mapPushError("weird")).toBe("weird");
  });
});

describe("saveConfig permissions (0o600, re-chmods an existing lax file)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "md-cli-cfg-"));
    ({ dir, file } = configPaths(base));
  });

  afterEach(() => {
    // Clean up the whole mkdtemp base (parent of `dir`).
    rmSync(join(dir, "..", ".."), { recursive: true, force: true });
  });

  it("writes a new config file with 0o600 mode", () => {
    saveConfig(dir, file, { token: "pat_secret" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig(file)).toEqual({ token: "pat_secret" });
  });

  it("tightens an existing world-readable (0o644) config to 0o600 on save", () => {
    // Simulate a config written before the hardening, with lax permissions.
    saveConfig(dir, file, { token: "old" });
    writeFileSync(file, JSON.stringify({ token: "old" }), { mode: 0o644 });
    // Chmod explicitly too, in case umask/create semantics kept it tighter.
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);

    saveConfig(dir, file, { token: "new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, "utf8")) as Config;
    expect(written.token).toBe("new");
  });
});

describe("loadConfig", () => {
  it("returns an empty object for a missing/unparseable file", () => {
    expect(loadConfig(join(tmpdir(), "definitely-missing-md-config.json"))).toEqual({});
  });
});
