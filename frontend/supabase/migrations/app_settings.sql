-- app_settings: key/value настройки приложения (редактируются в Админке, тянутся из БД).
-- Прогнать один раз в Supabase SQL Editor проекта «crews scheduling».

create table if not exists public.app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.app_settings enable row level security;

-- Читать настройки может любой залогиненный (фронту нужен URL вебхука).
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select to authenticated using (true);

-- Менять — только super_admin (app_role enum: super_admin | pm | team_lead).
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings
  for all to authenticated
  using (
    exists (select 1 from public.user_roles ur
            where ur.user_id = auth.uid() and ur.role = 'super_admin')
  )
  with check (
    exists (select 1 from public.user_roles ur
            where ur.user_id = auth.uid() and ur.role = 'super_admin')
  );

-- Стартовое значение вебхука планировщика (поменяешь в Админке).
insert into public.app_settings (key, value)
values ('planner_webhook_url', 'https://basementremodeling.app.n8n.cloud/webhook/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27')
on conflict (key) do nothing;
