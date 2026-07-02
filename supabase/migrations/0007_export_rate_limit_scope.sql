-- Allow the IP-only limiter to record 'export' attempts (agent-read export feature).
-- The 0005 CHECK constraint only permitted password/early_access/upload; inserting
-- scope = 'export' would violate it. Drop + recreate the CHECK with the new value.
--
-- Constraint name: 0005 added the column as:
--   add column if not exists scope text not null default 'password'
--   check (scope in ('password', 'early_access', 'upload'));
-- Postgres names an inline column CHECK as <table>_<column>_check, i.e.
-- auth_attempts_scope_check. Confirmed by inspecting 0005.
--
-- RLS: auth_attempts already has RLS enabled + deny-by-default (0002_rls.sql).
-- Service role is the only writer and bypasses RLS; no new policy needed.
--
-- Index: idx_auth_attempts_ip_scope (scope, ip, created_at) introduced in 0005
-- already serves the 'export' scope lookups — no new index required.

alter table auth_attempts
  drop constraint if exists auth_attempts_scope_check;

alter table auth_attempts
  add constraint auth_attempts_scope_check
  check (scope in ('password', 'early_access', 'upload', 'export'));
