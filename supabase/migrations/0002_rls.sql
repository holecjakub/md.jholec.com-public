-- RLS enforcement model (see team/04-be.md §4):
--   Route handlers use the service/secret key (bypasses RLS) and scope every query
--   by document_id from the verified session/PAT. RLS is enabled on all tables and
--   grants NO permissive policies to anon/authenticated => those roles read nothing.
--   This is defense-in-depth: a leaked publishable/anon key sees zero rows.

alter table documents              enable row level security;
alter table document_versions      enable row level security;
alter table participants           enable row level security;
alter table comments               enable row level security;
alter table reactions              enable row level security;
alter table access_tokens          enable row level security;
alter table personal_access_tokens enable row level security;
alter table auth_attempts          enable row level security;

-- Intentionally NO policies for anon/authenticated. Deny-by-default.
-- The service role bypasses RLS; all legitimate access flows through the trusted server.

-- The trusted server (service_role) is the ONLY DB caller. RLS bypass does NOT grant
-- table privileges, so grant them explicitly (do not rely on default-privilege setup).
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

-- Belt-and-braces: ensure anon/authenticated hold no table privileges (RLS already
-- denies, but revoking makes a leaked key read zero rows even if a policy is later
-- added by mistake).
revoke all on all tables in schema public from anon, authenticated;
