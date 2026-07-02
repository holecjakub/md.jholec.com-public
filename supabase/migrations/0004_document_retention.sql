-- Document retention (upload feature, plan §6.2/§6.3). Documents live 30 days, then a
-- pg_cron job (0006) deletes them; FK cascades remove document_versions, participants,
-- comments, reactions, access_tokens, personal_access_tokens (bound PATs) via the
-- existing on-delete-cascade FKs (verified in brief §6). auth_attempts rows with a
-- non-null document_id also cascade; rows with document_id = null (early-access/upload
-- scope) are untouched — they are IP signal, not document data.
-- access_tokens.expires_at is aligned to 30 days so a token never outlives (or appears
-- to outlive) the document it unlocks (see route.ts §3.3).

alter table documents
  add column if not exists expires_at timestamptz;

-- Backfill existing rows: 30 days from their creation date. Rows already older than 30
-- days get a near-future expiry rather than an immediate delete, so the first cron run
-- does not wipe pre-existing data without warning. Adjust the grace interval if undesired
-- (see brief §1.1 open question 1 — defaulted to the safe path).
update documents
  set expires_at = greatest(created_at + interval '30 days', now() + interval '30 days')
  where expires_at is null;

alter table documents
  alter column expires_at set not null,
  alter column expires_at set default (now() + interval '30 days');

-- Cleanup-scan index: the cron job filters on expires_at < now(). A plain btree on
-- expires_at makes that range scan index-only-ish and cheap even as the table grows.
create index if not exists idx_documents_expires_at on documents(expires_at);
