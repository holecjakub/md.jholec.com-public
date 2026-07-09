import type { ClientConfig } from "./types";

export interface ApiClient {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Reject plaintext base URLs before a Bearer PAT is ever attached (security
 * review L11). http:// is permitted only for loopback hosts (local dev);
 * anything else must be https:// so the token is never sent in the clear.
 */
function assertSecureBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname;
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost");
  if (url.protocol === "http:" && isLoopback) return;
  throw new Error(
    `Refusing to send a bearer token over ${url.protocol} to ${host}. ` +
      `Use an https:// base URL (http:// is allowed only for localhost).`,
  );
}

export function createClient(cfg: ClientConfig): ApiClient {
  assertSecureBaseUrl(cfg.baseUrl);
  return {
    baseUrl: cfg.baseUrl.replace(/\/$/, ""),
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  };
}
