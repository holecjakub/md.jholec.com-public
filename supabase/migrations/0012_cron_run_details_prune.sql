-- Tech-stack audit M8 + M9.
--
-- M8: pg_cron jobs (0006 retention + auth-attempt prune) write one row per run into
-- cron.job_run_details, which pg_cron NEVER prunes — unbounded growth — and nothing
-- surfaces failed runs. This migration (a) schedules a daily prune keeping 7 days of
-- run history and (b) adds a `cron_recent_failures` view so a failing job is one
-- SELECT away in the dashboard instead of invisible.
--
-- M9 (defense-in-depth): PATs are document-bound since 0003 and every app mint path
-- sets document_id, but the column itself stayed nullable. Add a CHECK so no future
-- code path (or ad-hoc SQL) can ever mint an unbound, universal token again.
--
-- Idempotent (hand-applied in the dashboard SQL Editor — see AI/tools.md): safe to
-- paste more than once. SELF-HOSTED FALLBACK: same as 0006 — if pg_cron cannot be
-- enabled, skip the scheduling here and run `select public.prune_cron_job_run_details()`
-- from an external scheduler; the PAT constraint block at the bottom is independent
-- of pg_cron and must still be applied.

create extension if not exists pg_cron;

-- Keep 7 days of run history: enough to inspect recent failures (the busiest job is
-- hourly → ~168 rows/job/week) while keeping the table bounded.
create or replace function public.prune_cron_job_run_details()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Only the cron worker (postgres / superuser) invokes it.
revoke all on function public.prune_cron_job_run_details() from public, anon, authenticated;

-- Daily at 03:45 (after prune-auth-attempts at 03:15). Unschedule first so re-applying
-- the migration does not create a duplicate job (idempotent, same pattern as 0006).
select cron.unschedule('prune-cron-job-run-details')
  where exists (select 1 from cron.job where jobname = 'prune-cron-job-run-details');

select cron.schedule(
  'prune-cron-job-run-details',
  '45 3 * * *',
  $$select public.prune_cron_job_run_details();$$
);

-- Failure surfacing: `select * from cron_recent_failures` in the SQL Editor shows
-- every failed run of the last 7 days (the retention window above). Plain view —
-- it runs with its owner's privileges (postgres, since migrations are pasted in the
-- dashboard SQL Editor), which is what lets it read the cron schema. Left join so
-- runs of since-unscheduled jobs still show, identified by their command text.
create or replace view public.cron_recent_failures as
select
  coalesce(j.jobname, d.command) as job,
  d.status,
  d.return_message,
  d.start_time,
  d.end_time
from cron.job_run_details d
left join cron.job j using (jobid)
where d.status = 'failed'
  and d.start_time > now() - interval '7 days'
order by d.start_time desc;

-- 0009 already revokes default privileges for new objects; revoke explicitly anyway
-- so the view is operator-only even where 0009 was applied after object creation.
revoke all on public.cron_recent_failures from public, anon, authenticated;

-- M9: require document binding for every NEW personal access token. NOT VALID because
-- pre-0003 unbound rows may still exist (0003 revoked them but kept the rows); the
-- constraint therefore applies to new inserts/updates only, which is exactly the
-- guarantee we need — an unbound PAT can never be minted again.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'personal_access_tokens_document_id_required'
      and conrelid = 'public.personal_access_tokens'::regclass
  ) then
    alter table public.personal_access_tokens
      add constraint personal_access_tokens_document_id_required
      check (document_id is not null) not valid;
  end if;
end $$;
