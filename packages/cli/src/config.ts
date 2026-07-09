/**
 * Pure, side-effect-light CLI helpers extracted from `index.ts` so they can be
 * unit-tested without executing the top-level `program.parseAsync(argv)` that
 * runs on import. Everything here takes its inputs (env, config, config path)
 * explicitly rather than reaching for module-level globals — that is what makes
 * it testable with a fake home dir and a fake env.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@md/core";

export interface Config {
  token?: string;
  apiUrl?: string;
  /** Early-access gate grant (from `md auth unlock`) — sent as the gate cookie on `md new`. */
  earlyAccessGrant?: string;
}

export const DEFAULT_API_URL = "https://md.jholec.com/api";

/** Owner-only config permissions: readable/writable by the user, nobody else. */
const CONFIG_MODE = 0o600;

export const UPLOAD_LOCKED_MESSAGE =
  "Upload is locked. Run `md auth unlock --password <password>` first.";

/** Resolve the on-disk config location. Injectable home dir for tests. */
export function configPaths(home: string = homedir()): { dir: string; file: string } {
  const dir = join(home, ".config", "md");
  return { dir, file: join(dir, "config.json") };
}

export function loadConfig(file: string): Config {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(dir: string, file: string, cfg: Config): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: CONFIG_MODE });
  // writeFileSync's `mode` is only honoured when the file is *created*. A config
  // that already exists (written before this hardening, or under a lax umask)
  // keeps its old — possibly group/world-readable — permissions, leaking the PAT.
  // chmod unconditionally so an existing 0644 file is tightened to 0600 on every save.
  try {
    chmodSync(file, CONFIG_MODE);
  } catch {
    // Non-POSIX filesystem (e.g. Windows) — permissions are best-effort there.
  }
}

/** Base URL precedence: MD_API_URL env → config → hosted default. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv, cfg: Config): string {
  return env.MD_API_URL ?? cfg.apiUrl ?? DEFAULT_API_URL;
}

/** Token for authenticated commands: MD_TOKEN env → config; undefined if neither. */
export function resolveAuthToken(env: NodeJS.ProcessEnv, cfg: Config): string | undefined {
  return env.MD_TOKEN ?? cfg.token;
}

/**
 * Token for anonymous commands (e.g. `md new`). Falls back to the sentinel
 * "none" so a Bearer header is always present even when unauthenticated.
 */
export function resolveAnonToken(env: NodeJS.ProcessEnv, cfg: Config): string {
  return env.MD_TOKEN ?? cfg.token ?? "none";
}

/**
 * Map an error thrown by `pushDocument` to the message shown to the user.
 * A 403 is remapped to the actionable "unlock" hint; other API errors keep
 * their status; anything else is stringified.
 */
export function mapPushError(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return UPLOAD_LOCKED_MESSAGE;
  if (e instanceof ApiError) return `Error ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
