-- Perf M9: the rate limiter (lib/auth/rate-limit.ts) did INSERT then COUNT as two
-- sequential PostgREST round-trips on every gated request (password auth, upload,
-- export, redeem, and every comment/reply/react write). Fold both into one RPC so
-- each limiter check costs a single round-trip.
--
-- One function serves both limiter shapes, branching on p_document_id so each
-- branch stays a plain planner-friendly query on its covering index:
--   * per-document (scope 'password'): (document_id, ip, created_at)
--     via idx_auth_attempts_lookup (0001)
--   * IP-only (document_id null):      (scope, ip, created_at)
--     via idx_auth_attempts_ip_scope (0005)
-- The window start (p_since) is passed in so WINDOW_MS stays authoritative in TS.
-- The count is taken after the insert in the same transaction, so it includes the
-- attempt just recorded — identical semantics to the old INSERT-then-COUNT pair.
--
-- As a side effect the returned count is now unambiguous: a limiter DB failure
-- surfaces as an RPC error instead of a null count that is indistinguishable from
-- zero rows (the head+count blocker noted in rate-limit.ts). Fail-closed remains a
-- deliberate follow-up hardening decision in the TS caller.
--
-- The daily prune (prune_auth_attempts, 0006) is unchanged and still bounds the table.
--
-- RLS: auth_attempts is deny-by-default (0002); SECURITY DEFINER matches the existing
-- retention/prune functions. Only service_role (the trusted server) may execute.

create or replace function public.record_auth_attempt(
  p_document_id uuid,
  p_ip text,
  p_scope text,
  p_since timestamptz
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt_count bigint;
begin
  insert into public.auth_attempts (document_id, ip, scope)
  values (p_document_id, p_ip, p_scope);

  if p_document_id is null then
    select count(*) into attempt_count
    from public.auth_attempts
    where scope = p_scope
      and ip = p_ip
      and created_at >= p_since;
  else
    select count(*) into attempt_count
    from public.auth_attempts
    where document_id = p_document_id
      and ip = p_ip
      and created_at >= p_since;
  end if;

  return attempt_count;
end;
$$;

revoke all on function public.record_auth_attempt(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_auth_attempt(uuid, text, text, timestamptz)
  to service_role;
