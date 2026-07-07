-- App-settings фреймворк: настройки конкретного приложения (не портала).
-- Одна таблица key/value на все апки. Читать может любой authenticated (вебхук-URL не секрет
-- сам по себе — клиент его фетчит; для секретности нужен edge-прокси). Писать — только админ.
--
-- ⚠️ Применяется на существующем Lovable-Supabase вручную (SQL Editor). Использует уже
-- существующую RPC public.user_has_admin_role(uuid) (её же дёргает портал в checkAdmin).

create table if not exists public.app_settings (
  id         uuid primary key default gen_random_uuid(),
  app_code   text not null,           -- код приложения: 'sales', 'production-checklist', …
  key        text not null,           -- напр. 'offer_webhook'
  value      jsonb,                   -- значение (для вебхука — строка URL)
  updated_at timestamptz not null default now(),
  unique (app_code, key)
);

alter table public.app_settings enable row level security;

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

drop policy if exists app_settings_admin_write on public.app_settings;
create policy app_settings_admin_write on public.app_settings
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

grant select, insert, update, delete on public.app_settings to authenticated;
