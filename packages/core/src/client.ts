import type { ClientConfig } from "./types";

export interface ApiClient {
  baseUrl: string;
  headers: Record<string, string>;
}

export function createClient(cfg: ClientConfig): ApiClient {
  return {
    baseUrl: cfg.baseUrl.replace(/\/$/, ""),
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  };
}
