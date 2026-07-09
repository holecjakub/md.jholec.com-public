-- Missing FK indexes (audit CQ2-DB-INDEXES).
--
-- Postgres does NOT auto-create indexes for foreign-key columns. Without them,
-- every ON DELETE CASCADE / ON DELETE SET NULL from the referenced (parent) side
-- forces a sequential scan of the referencing (child) table to find rows to
-- cascade. The columns below back FKs that were previously unindexed.
--
-- Purely additive + idempotent: `create index if not exists`, no data migration.
-- Second apply is a no-op.

-- comments.version_id -> document_versions(id) ON DELETE CASCADE
create index if not exists idx_comments_version on comments(version_id);

-- comments.participant_id -> participants(id) ON DELETE CASCADE
create index if not exists idx_comments_participant on comments(participant_id);

-- reactions.participant_id -> participants(id) ON DELETE CASCADE
create index if not exists idx_reactions_participant on reactions(participant_id);

-- documents.current_version_id -> document_versions(id) ON DELETE SET NULL
create index if not exists idx_documents_current_version on documents(current_version_id);

-- Ordered comment-list queries (per document, chronological). Supersedes the
-- single-column idx_comments_document for `where document_id = ? order by created_at`.
create index if not exists idx_comments_document_created on comments(document_id, created_at);

-- OBSERVATION (future dedupe, NOT changed here — product decision):
-- Each password-auth / token-redeem flow can insert a fresh `participants` row
-- for the same human (there is no natural unique key across identity_cookie /
-- oauth_subject), so a single reviewer may accumulate duplicate participant rows
-- across sessions. A future migration could dedupe (e.g. a partial unique index
-- on (document_id, oauth_provider, oauth_subject) where oauth_subject is not null,
-- plus a merge of orphaned comments/reactions). Deliberately left as-is here.
