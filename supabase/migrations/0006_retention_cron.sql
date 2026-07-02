-- Auto-delete expired documents (upload feature, plan §6.3). pg_cron runs a SECURITY
-- DEFINER function hourly; deleting a document cascades to document_versions, participants,
-- comments, reactions, access_tokens, and bound personal_access_tokens via the existing
-- on-delete-cascade FKs (verified, see brief §6).
--
-- SELF-HOSTED FALLBACK: if a self-hosted Postgres image lacks the pg_cron shared-preload-
-- library, `create extension pg_cron` will fail at migration time. In that environment the
-- operator must either (a) add `pg_cron` to shared_preload_libraries and restart Postgres,
-- or (b) skip this migration (0006) and invoke `select public.delete_expired_documents()`
-- from an external scheduler (host cron / a GitHub Action hitting a protected admin route).
-- The function defined below is the unit of work either way; only the scheduling is
-- environment-specific. Hosted Supabase: pg_cron is a standard extension available on all
-- hosted projects — this migration self-enables it with `create extension if not exists`.

create extension if not exists pg_cron;

create or replace function public.delete_expired_documents()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.documents where expires_at < now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Revoke from all unprivileged roles; only the cron worker (postgres / superuser) invokes it.
revoke all on function public.delete_expired_documents() from public, anon, authenticated;

-- Hourly at minute 0. 30-day retention does not need sub-hour precision; hourly keeps the
-- expired window small (<= 1h past expiry) without load. Unschedule first so re-applying
-- the migration does not create a duplicate job (idempotent).
select cron.unschedule('delete-expired-documents')
  where exists (select 1 from cron.job where jobname = 'delete-expired-documents');

select cron.schedule(
  'delete-expired-documents',
  '0 * * * *',
  $$select public.delete_expired_documents();$$
);

-- Prune the rate-limit ledger. auth_attempts now also records IP-only rows (early_access /
-- upload scope, document_id null) that no document delete will ever cascade away, so the
-- table would grow unbounded. The limiter only reads a 15-minute window, so anything older
-- than a day is dead weight. Daily prune at 03:15.
create or replace function public.prune_auth_attempts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.auth_attempts where created_at < now() - interval '1 day';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_auth_attempts() from public, anon, authenticated;

select cron.unschedule('prune-auth-attempts')
  where exists (select 1 from cron.job where jobname = 'prune-auth-attempts');

select cron.schedule(
  'prune-auth-attempts',
  '15 3 * * *',
  $$select public.prune_auth_attempts();$$
);
