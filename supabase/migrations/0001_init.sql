-- md.jholec.com v1 schema (spec §4). Postgres 17: gen_random_uuid() is built-in.

create table documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  password_hash text not null,            -- argon2id
  owner_email text,
  current_version_id uuid,                -- FK added after document_versions exists
  account_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version_no int not null,
  content text not null,
  storage_path text,
  created_at timestamptz not null default now(),
  unique (document_id, version_no)
);

alter table documents
  add constraint documents_current_version_fk
  foreign key (current_version_id) references document_versions(id) on delete set null;

create table participants (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  display_name text not null,
  identity_cookie text,
  oauth_provider text,
  oauth_subject text,
  role text not null default 'reviewer' check (role in ('reviewer','owner')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  anchor jsonb not null,
  body text not null,
  parent_id uuid references comments(id) on delete cascade,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reactions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  comment_id uuid references comments(id) on delete cascade,
  anchor jsonb,
  participant_id uuid not null references participants(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (comment_id, participant_id, emoji)
);

create table access_tokens (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  token_hash text not null unique,        -- SHA-256 hex of a 256-bit token
  kind text not null check (kind in ('invite','owner')),
  reusable boolean not null default false,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table personal_access_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid,
  owner_email text,
  token_hash text not null unique,        -- SHA-256 hex
  name text not null,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table auth_attempts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  ip text not null,
  created_at timestamptz not null default now()
);

-- Indexes (spec §4: slug, token_hash, document_id FKs)
create index idx_document_versions_document on document_versions(document_id);
create index idx_participants_document on participants(document_id);
create index idx_comments_document on comments(document_id);
create index idx_comments_parent on comments(parent_id);
create index idx_reactions_comment on reactions(comment_id);
create index idx_reactions_document on reactions(document_id);
create index idx_access_tokens_document on access_tokens(document_id);
create index idx_auth_attempts_lookup on auth_attempts(document_id, ip, created_at);
