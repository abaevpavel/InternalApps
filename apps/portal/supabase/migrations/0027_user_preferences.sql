-- BAS-1681: личные настройки интерфейса, которые должны жить за пользователем, а не за
-- браузером (сейчас — вид главной: карточки или список).
--
-- Отдельная таблица, а не колонка в profiles: у profiles на проде свои политики и триггер
-- защиты колонок, менять их ради настройки вида незачем. Здесь всё просто — каждый
-- читает и пишет только свою строку.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.user_preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  home_view  text not null default 'cards' check (home_view in ('cards', 'list')),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists user_preferences_own on public.user_preferences;
create policy user_preferences_own on public.user_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.user_preferences from anon;
grant select, insert, update on public.user_preferences to authenticated;

-- Свёрнутые/развёрнутые блоки (BAS-1628) — тоже за пользователем:
-- { "<группа экрана>": { "<id блока>": true|false (открыт) } }. Только явные выборы
-- человека; чего нет — берётся умолчание экрана (у GMB Agent все блоки свёрнуты).
alter table public.user_preferences
  add column if not exists ui_state jsonb not null default '{}'::jsonb;
