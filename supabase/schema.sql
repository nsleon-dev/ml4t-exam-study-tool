-- ML4T Study: one progress document per user.
-- Run in the Supabase dashboard → SQL Editor.

create table if not exists public.progress (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  rev        integer     not null default 1,     -- optimistic concurrency: writers must match the rev they read
  updated_at timestamptz not null default now()
);

alter table public.progress enable row level security;

-- Each signed-in user can only see and change their own row.
drop policy if exists "progress_select_own" on public.progress;
drop policy if exists "progress_insert_own" on public.progress;
drop policy if exists "progress_update_own" on public.progress;
drop policy if exists "progress_delete_own" on public.progress;

create policy "progress_select_own" on public.progress
  for select to authenticated using (auth.uid() = user_id);
create policy "progress_insert_own" on public.progress
  for insert to authenticated with check (auth.uid() = user_id);
create policy "progress_update_own" on public.progress
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "progress_delete_own" on public.progress
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Question pool: readable only by signed-in users; written only with the
-- service-role key (tools/upload_pool.py). No insert/update policies exist,
-- so the anon and authenticated roles can never modify it.

create table if not exists public.question_pool (
  id         text primary key,          -- always 'current'
  version    text        not null,      -- content hash; clients re-download only when it changes
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.question_pool enable row level security;

drop policy if exists "pool_read_signed_in" on public.question_pool;
create policy "pool_read_signed_in" on public.question_pool
  for select to authenticated using (true);

-- Optional: allow only certain email addresses to read the pool, e.g. Georgia Tech accounts.
-- Replace the policy above with:
--   create policy "pool_read_signed_in" on public.question_pool
--     for select to authenticated using ((auth.jwt() ->> 'email') ilike '%@gatech.edu');
