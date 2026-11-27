-- feature-board schema. Applied idempotently on startup (see db.ts).

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (email = lower(email)),
  name          text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Only the SHA-256 of the session token is stored, so a leaked table
-- cannot be replayed as cookies.
create table if not exists sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);

create table if not exists login_failures (
  email       text not null,
  failed_at   timestamptz not null default now()
);
create index if not exists login_failures_email_idx on login_failures(email, failed_at);

create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists memberships_user_idx on memberships(user_id);

create table if not exists invites (
  token_hash   text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role         text not null check (role in ('admin', 'member')),
  created_by   uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  used_by      uuid references users(id) on delete set null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists requests (
  id           uuid primary key default gen_random_uuid(),
  -- Insertion order. created_at can tie within a millisecond; this cannot.
  seq          bigint generated always as identity,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  author_id    uuid references users(id) on delete set null,
  title        text not null,
  body         text not null default '',
  status       text not null default 'open'
               check (status in ('open', 'planned', 'in_progress', 'done', 'declined')),
  created_at   timestamptz not null default now()
);
create index if not exists requests_ws_idx on requests(workspace_id, seq desc);

-- One vote per user per request is a primary key, not an application check,
-- so double clicks and concurrent tabs cannot double count.
create table if not exists votes (
  request_id uuid not null references requests(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
