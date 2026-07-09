import path from "node:path";
import type { NextConfig } from "next";

// Global security response headers (security review L2). The token-bearing
// /d/[slug] page previously shipped none. CSP is a defense-in-depth backstop —
// markdown is sanitized server-side (rehype-sanitize last, no rehype-raw, no
// dangerouslySetInnerHTML), so there is no live XSS path today. 'unsafe-inline'
// is required for Next's injected runtime/styles.
// TODO(security L8): replace 'unsafe-inline' in script-src with per-request nonces
// (needs middleware to mint the nonce and stamp the header; static headers() here
// cannot). 'unsafe-eval' is dev-only: Next/Turbopack HMR needs eval, production
// bundles do not, so prod CSP omits it.
// The browser talks to Supabase REST + Realtime directly. In prod that's the
// *.supabase.co host; locally it's 127.0.0.1:54321. Derive the exact origin (and
// its ws:// variant) from the public env so the CSP allows it in every env.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseConnect =
  SUPABASE_URL && !SUPABASE_URL.includes(".supabase.co")
    ? `${SUPABASE_URL} ${SUPABASE_URL.replace(/^http/, "ws")}`
    : "";

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co${supabaseConnect ? ` ${supabaseConnect}` : ""}`,
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to this monorepo so Next does not infer an
  // unrelated parent lockfile (e.g. ~/package-lock.json) as the root.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
