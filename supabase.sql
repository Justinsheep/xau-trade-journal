-- XAU 交易紀錄：手機電腦同步用的資料表
-- 到 Supabase（資產 App 那個專案）→ SQL Editor → New query → 整段貼上 → Run
create table if not exists public.xau_journal (
  user_id uuid primary key references auth.users on delete cascade default auth.uid(),
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.xau_journal enable row level security;
drop policy if exists "own xau journal" on public.xau_journal;
create policy "own xau journal" on public.xau_journal
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- 讓另一台裝置改了之後，這台馬上收到
alter publication supabase_realtime add table public.xau_journal;
