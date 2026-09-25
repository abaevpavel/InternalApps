-- Dev Apps: кто шлёт вебхук сценария Make — Mac-приложение (estimatingTool) или другой внешний
-- источник (JotForm, QuickBooks, Retool…). BAS-1504 / BAS-1503.
--
-- Разработчики определяют это по ходу с экрана, поэтому — в базе, а не в снимке JSON (снимок
-- пересобирается скриптом и затёр бы ручную разметку). Нет строки — экран берёт значение по
-- умолчанию из снимка. Ключ — id сценария Make.
--
-- Доступ — как у Dev Apps: '/dev-apps' или админ. Применять вручную: SQL Editor. Идемпотентно.

create table if not exists public.dev_webhook_sources (
  scenario_id     bigint primary key,
  kind            text        not null check (kind in ('mac_app', 'external', 'unknown')),
  sender          text        check (sender is null or length(sender) <= 120),
  note            text        check (note is null or length(note) <= 2000),
  updated_by      uuid        default auth.uid(),
  updated_by_name text,
  updated_at      timestamptz not null default now()
);

create or replace function public.dev_webhook_sources_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email)
    into new.updated_by_name
  from public.profiles p where p.user_id = auth.uid() limit 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists dev_webhook_sources_touch on public.dev_webhook_sources;
create trigger dev_webhook_sources_touch before insert or update on public.dev_webhook_sources
  for each row execute function public.dev_webhook_sources_touch();

alter table public.dev_webhook_sources enable row level security;

drop policy if exists dev_webhook_sources_access on public.dev_webhook_sources;
create policy dev_webhook_sources_access on public.dev_webhook_sources for all to authenticated
  using (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'))
  with check (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'));

revoke all on public.dev_webhook_sources from anon, authenticated;
grant select, insert, update on public.dev_webhook_sources to authenticated;
