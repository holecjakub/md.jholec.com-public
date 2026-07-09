-- Security hardening (audit L3): close the default-privileges gap left by 0002.
-- 0002 revoked anon/authenticated privileges on all *existing* tables, but Supabase's
-- stock default privileges still grant those roles full access to any table created
-- *later* (e.g. by a future migration). Revoke the defaults so new tables start with
-- zero anon/authenticated privileges, matching the deny-by-default RLS model where
-- the trusted server (service_role) is the only DB caller.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
