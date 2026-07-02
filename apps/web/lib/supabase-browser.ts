"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Memoized browser Supabase client built from the public (publishable/anon)
 * env vars. Used ONLY for Realtime broadcast subscriptions — never for table
 * reads (RLS is deny-by-default for the anon key). No auth session is needed or
 * persisted; broadcast is key-agnostic message passing.
 */

let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
