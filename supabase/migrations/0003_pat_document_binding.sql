-- Security fix (review C1/C2): bind every Personal Access Token to a single
-- document. Previously a PAT was global — requireDocAccess granted owner over ANY
-- document to any valid PAT — so one token (or one unauthenticated mint) meant
-- cross-tenant takeover. PATs are now minted by a document's owner and only ever
-- authorize that one document.

alter table personal_access_tokens
  add column if not exists document_id uuid references documents(id) on delete cascade;

create index if not exists personal_access_tokens_document_id_idx
  on personal_access_tokens (document_id);

-- Any pre-existing token was global/unbound and therefore over-privileged. Revoke
-- them so they can never be used as universal-owner tokens after this migration.
update personal_access_tokens
  set revoked_at = now()
  where document_id is null and revoked_at is null;
