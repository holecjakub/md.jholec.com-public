/**
 * Shared test helpers for the md.jholec.com Playwright suite.
 *
 * Gate-aware seeding:
 *   - unlockGate(request)       — POST /api/early-access once per context; caches result.
 *   - seedDocument(request, opts) — gate-aware create; asserts 201; returns full payload.
 *
 * File builders for setFiles:
 *   - mdFile(name, content)
 *   - txtFile(name)
 *   - oversizedMdFile()         — > 2 MB
 *   - emptyMdFile()
 *
 * A11y:
 *   - expectNoSeriousA11yViolations(page, context)
 *
 * Rate-limit management (local only):
 *   - resetRateLimits()         — deletes 0.0.0.0 rows from auth_attempts in local Supabase.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Never hardcode the early-access password in committed source (this repo is the
// open-source/self-host product — a literal here would defeat the gate). It is read
// from the env, which playwright.config.ts loads from the gitignored .env.local
// (CI sets it directly). Tests fail loudly if it is unset.
export const EARLY_ACCESS_PASSWORD = process.env.EARLY_ACCESS_PASSWORD ?? "";

export const VALID_MARKDOWN = [
  "# Quarterly Report",
  "",
  "## Highlights",
  "",
  "This release is **very important** for the team.",
  "",
  "- First milestone",
  "- Second milestone",
  "",
  "```ts",
  "function greet(name: string) {",
  "  return `Hello, ${name}`;",
  "}",
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// File builders for setFiles
// ---------------------------------------------------------------------------

export function mdFile(
  name: string,
  content: string = VALID_MARKDOWN,
): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: "text/markdown", buffer: Buffer.from(content) };
}

export function txtFile(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("This is a plain text file, not markdown."),
  };
}

export function oversizedMdFile(): { name: string; mimeType: string; buffer: Buffer } {
  // Slightly above the 2 MB limit (2,097,153 bytes).
  return {
    name: "big.md",
    mimeType: "text/markdown",
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1, "a"),
  };
}

export function emptyMdFile(): { name: string; mimeType: string; buffer: Buffer } {
  return { name: "empty.md", mimeType: "text/markdown", buffer: Buffer.from("") };
}

// ---------------------------------------------------------------------------
// Gate unlock cache (per APIRequestContext identity)
// ---------------------------------------------------------------------------

// WeakMap so it GCs when the context is disposed.
const unlockedContexts = new WeakMap<APIRequestContext, boolean>();

/**
 * Unlock the early-access gate exactly once per APIRequestContext.
 * Subsequent calls are no-ops (cookie persists on the context).
 * Resets the early_access rate-limit bucket before each first-time unlock and
 * retries once on 429 (with a fresh reset) so parallel specs never exhaust the
 * 10/15min bucket even when many workers race to unlock simultaneously.
 */
export async function unlockGate(request: APIRequestContext): Promise<void> {
  if (unlockedContexts.get(request)) return;

  // Reset rate limits so we have a fresh bucket before unlocking.
  await resetRateLimits();

  let res = await request.post("/api/early-access", {
    data: { password: EARLY_ACCESS_PASSWORD },
  });

  // On 429 (parallel workers may race between our reset and this POST),
  // reset again and retry once.
  if (res.status() === 429) {
    await resetRateLimits();
    res = await request.post("/api/early-access", {
      data: { password: EARLY_ACCESS_PASSWORD },
    });
  }

  expect(res.status(), `unlockGate failed: ${await res.text()}`).toBe(200);
  unlockedContexts.set(request, true);
}

// ---------------------------------------------------------------------------
// Gate-aware document seeder
// ---------------------------------------------------------------------------

export interface SeedDocResult {
  slug: string;
  shareUrl: string;
  ownerUrl: string;
  /** Read-only agent GET capability URL. Token is in the path: /d/<slug>/agent/<token>. */
  agentUrl: string;
  expiresAt: string;
}

/**
 * Create a document via POST /api/documents with the gate cookie present.
 * Unlocks lazily if needed. Asserts 201 with a readable failure message.
 *
 * All existing specs that were seeding via an inline POST /api/documents call
 * must use this instead — the endpoint now requires the md_early_access cookie.
 */
export async function seedDocument(
  request: APIRequestContext,
  opts: { title?: string; content?: string; password?: string } = {},
): Promise<SeedDocResult> {
  await unlockGate(request);

  const res = await request.post("/api/documents", {
    data: {
      title: opts.title ?? "E2E Seed Document",
      content: opts.content ?? VALID_MARKDOWN,
      password: opts.password ?? "test-password",
    },
  });

  expect(res.status(), `seedDocument failed (${res.status()}): ${await res.text()}`).toBe(201);

  const body = (await res.json()) as {
    slug: string;
    shareUrl: string;
    ownerUrl: string;
    agentUrl: string;
    expiresAt: string;
  };

  expect(body.slug).toBeTruthy();
  expect(body.shareUrl).toContain("#t=");
  expect(body.ownerUrl).toContain("#o=");
  // agentUrl is now a GET capability URL: /d/<slug>/agent/<token> — token in path, no fragment.
  expect(body.agentUrl).toMatch(/\/d\/[^/]+\/agent\/pat_/);
  expect(body.expiresAt).toBeTruthy();

  return {
    slug: body.slug,
    shareUrl: body.shareUrl,
    ownerUrl: body.ownerUrl,
    agentUrl: body.agentUrl,
    expiresAt: body.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// A11y helper
// ---------------------------------------------------------------------------

/**
 * Assert no serious or critical axe violations on the page.
 * Produces a human-readable failure message listing each violation.
 */
export async function expectNoSeriousA11yViolations(
  page: Page,
  context: string,
): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  const summary = serious
    .map((v) => `${v.id} (${v.impact}): ${v.help}`)
    .join("\n");
  expect(
    serious,
    `Serious/critical a11y violations on ${context}:\n${summary}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Rate-limit reset (local Supabase only)
// ---------------------------------------------------------------------------

/**
 * Delete rate-limit rows for all local-loopback IPs from auth_attempts.
 * Clears 0.0.0.0 (API requests with no x-forwarded-for), ::1 (IPv6 localhost,
 * used by browser requests in local dev), and 127.0.0.1 (IPv4 localhost).
 * Refuses to run if the Supabase URL is not localhost — never runs against prod.
 *
 * Call from globalSetup so the suite starts with a clean slate and is rerunnable.
 */
export async function resetRateLimits(): Promise<void> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!supabaseUrl.includes("localhost") && !supabaseUrl.includes("127.0.0.1")) {
    throw new Error(
      `resetRateLimits: refusing to run against non-localhost Supabase (${supabaseUrl}). ` +
        "This guard prevents accidental data loss on a real project.",
    );
  }

  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!serviceKey) {
    throw new Error("resetRateLimits: SUPABASE_SERVICE_ROLE_KEY is not set.");
  }

  // Delete rate-limit rows for ALL local-loopback IP variants. In local dev,
  // browser-driven requests arrive as ::1 (IPv6 localhost), while API-only requests
  // (playwright.request.newContext) may arrive as 0.0.0.0 (no x-forwarded-for header).
  const localIps = ["0.0.0.0", "::1", "127.0.0.1"];

  for (const ip of localIps) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/auth_attempts?ip=eq.${encodeURIComponent(ip)}&scope=in.(early_access,upload,export,redeem,write)`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`resetRateLimits: DELETE for ip=${ip} failed (${res.status}): ${body}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-IP rate-limit cleanup (for dedicated XFF test IPs)
// ---------------------------------------------------------------------------

/**
 * Delete all auth_attempts rows for a specific IP (any scope).
 * Used by rate-limit tests that forge a dedicated `x-forwarded-for` IP so
 * they don't share a bucket with the rest of the suite.
 * Reads env vars from the process environment (playwright.config.ts loads
 * .env.local before workers start).
 */
export async function deleteRateLimitRowsForIp(ip: string): Promise<void> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!supabaseUrl.includes("localhost") && !supabaseUrl.includes("127.0.0.1")) {
    throw new Error(
      `deleteRateLimitRowsForIp: refusing to run against non-localhost Supabase (${supabaseUrl}).`,
    );
  }
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!serviceKey) {
    throw new Error("deleteRateLimitRowsForIp: SUPABASE_SERVICE_ROLE_KEY is not set.");
  }
  const res = await fetch(
    `${supabaseUrl}/rest/v1/auth_attempts?ip=eq.${encodeURIComponent(ip)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `deleteRateLimitRowsForIp: DELETE for ip=${ip} failed (${res.status}): ${body}`,
    );
  }
}
