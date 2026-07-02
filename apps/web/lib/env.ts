function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  sessionSecret: required("SESSION_SIGNING_SECRET"),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? "3600"),
  baseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  // Server-only (env.ts is imported only by route handlers / server code; never the client
  // bundle). The real value is provisioned outside git — apps/web/.env.local for dev/tests,
  // host env in production. No literal fallback: when unset the value is "" and the
  // /api/early-access route fails closed (500), so a misconfigured deploy never opens the gate.
  earlyAccessPassword: process.env.EARLY_ACCESS_PASSWORD ?? "",
  earlyAccessTtlSeconds: Number(process.env.EARLY_ACCESS_TTL_SECONDS ?? "1800"),
} as const;
