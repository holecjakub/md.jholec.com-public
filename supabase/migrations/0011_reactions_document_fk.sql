-- Perf M10 folded the react toggle (POST .../comments/[id]/react) into
-- DELETE ... RETURNING else INSERT ... ON CONFLICT DO NOTHING on the existing
-- UNIQUE(comment_id, participant_id, emoji) index, removing the comment-exists
-- SELECT. That SELECT also enforced document scoping (comment_id must belong to
-- the session's document); the plain comment_id FK only rejects *nonexistent*
-- ids, not a valid comment id from another document. Replace the application-
-- level check with a composite FK so the database itself rejects cross-document
-- inserts (foreign_key_violation 23503 → the route's 404).
--
-- comments.id is already the PK; the extra UNIQUE (id, document_id) exists only
-- as the composite FK's required referenced key (standard pattern).
--
-- reactions.comment_id stays nullable (doc-level reactions carry an anchor and
-- no comment); MATCH SIMPLE skips FK enforcement when comment_id is null, same
-- as the single-column FK it replaces. ON DELETE CASCADE behavior is unchanged.
-- No existing row can violate the FK: the route has always inserted reactions
-- with the comment's own document_id.

alter table comments
  add constraint comments_id_document_key unique (id, document_id);

alter table reactions
  drop constraint if exists reactions_comment_id_fkey;

alter table reactions
  add constraint reactions_comment_document_fkey
  foreign key (comment_id, document_id)
  references comments(id, document_id)
  on delete cascade;
