-- Allow the IP-only limiter to record 'redeem' and 'write' attempts (security-audit
-- hardening: throttle the session-minting redeem path and comment/reply/react writes).
-- The 0007 CHECK constraint permitted password/early_access/upload/export; inserting
-- scope = 'redeem' or 'write' would violate it (the INSERT fails and the limiter silently
-- never trips). Drop + recreate the CHECK with the two new values.
--
-- Constraint name: auth_attempts_scope_check (inline column CHECK from 0005, last
-- recreated in 0007). Confirmed by inspecting those migrations.
--
-- RLS: auth_attempts already has RLS enabled + deny-by-default (0002_rls.sql). Service
-- role is the only writer and bypasses RLS; no new policy needed.
--
-- Index: idx_auth_attempts_ip_scope (scope, ip, created_at) from 0005 already serves the
-- new scopes' (scope, ip, created_at) lookups — no new index required.

alter table auth_attempts
  drop constraint if exists auth_attempts_scope_check;

alter table auth_attempts
  add constraint auth_attempts_scope_check
  check (scope in ('password', 'early_access', 'upload', 'export', 'redeem', 'write'));
