-- Разрешить пользователю читать и редактировать СВОЮ строку profiles (экран Profile).
-- Прогнать в Supabase SQL Editor проекта «crews scheduling».
-- Предполагается, что profiles.id = auth.users.id и есть колонки first_name, last_name.

alter table public.profiles enable row level security;

-- Чтение своей строки (если уже есть более широкая политика для админов — она остаётся).
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated using (id = auth.uid());

-- Обновление своей строки.
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
