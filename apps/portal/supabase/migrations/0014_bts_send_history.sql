-- 03-Production — Send Buildertrend Schedule: история отправок.
--
-- До этого приложение не писало в базу ничего: после нажатия «Send» оставался только
-- файл в бакете под случайным uuid — без проекта, без автора и без отметки, что его
-- вообще отправили. Проверить «уходило ли расписание клиенту» можно было лишь в логах Make.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.bts_sends (
  id           uuid primary key default gen_random_uuid(),
  project_name text not null,
  -- [{ "url": "...", "name": "schedule.pdf" }] — то же, что ушло в Make.
  files        jsonb not null default '[]'::jsonb,
  sent_by      uuid references auth.users(id) on delete set null,
  sent_at      timestamptz not null default now(),
  -- 'sent' | 'failed'. Неудачные попытки тоже пишем: сейчас ошибка вебхука живёт
  -- только на экране и исчезает вместе с ним.
  status       text not null default 'sent',
  error        text
);

create index if not exists bts_sends_sent_at_idx  on public.bts_sends (sent_at desc);
create index if not exists bts_sends_project_idx  on public.bts_sends (project_name);

alter table public.bts_sends enable row level security;

-- Права как у остальных апок: доступ = приложение выдано ролью. Админ проходит всегда.
drop policy if exists bts_sends_app_users on public.bts_sends;
create policy bts_sends_app_users on public.bts_sends
  for all to authenticated
  using (public.user_has_application_access(auth.uid(), '/buildertrend-schedule'))
  with check (public.user_has_application_access(auth.uid(), '/buildertrend-schedule'));

drop policy if exists bts_sends_admin on public.bts_sends;
create policy bts_sends_admin on public.bts_sends
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

grant select, insert on public.bts_sends to authenticated;
