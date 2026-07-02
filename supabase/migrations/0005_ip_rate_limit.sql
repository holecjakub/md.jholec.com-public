-- IP-only rate limiting (upload feature, plan §6.1). The early-access gate and the upload
-- endpoint have no single document_id to key on, so auth_attempts.document_id becomes
-- nullable and a scope discriminator separates the attempt classes.
--
-- Decision D4: reuse auth_attempts with nullable document_id + scope discriminator rather
-- than a new table. One table, one limiter helper, one cleanup story. The existing per-
-- document limiter (isRateLimited) continues to work unchanged: it filters by document_id
-- and the DB default scope = 'password' keeps its rows isolated from the two new scopes.
--
-- The existing FK auth_attempts.document_id -> documents(id) on delete cascade is
-- preserved; nullable FKs are valid. Early-access / upload rows carry document_id = null.
-- RLS: auth_attempts already has deny-by-default (0002_rls.sql). Service role is the only
-- writer; no new policy needed.

alter table auth_attempts
  alter column document_id drop not null;

alter table auth_attempts
  add column if not exists scope text not null default 'password'
  check (scope in ('password', 'early_access', 'upload'));

-- IP+scope+time lookup for the IP-only limiter (no document_id in the predicate).
-- The existing idx_auth_attempts_lookup (document_id, ip, created_at) stays for the
-- per-document password path.
create index if not exists idx_auth_attempts_ip_scope on auth_attempts(scope, ip, created_at);
