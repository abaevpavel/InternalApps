-- ============================================================================
-- Task Planner → HR DASHBOARD (общий портал-Supabase pilxwhtkhysanpukaliu)
-- Миграция схемы с изоляцией префиксом tp_. Источник: дамп `crews scheduling`
-- (dhtewaqfcsejdllwhgtl, PG 17) schema=public, снят 2026-07-13.
--
-- Стратегия: НЕ сливаем с порталом — параллельный неймспейс tp_* в public.
-- Общий на проект только auth.users. Всё Task Planner = tp_* (таблицы, enum,
-- функции, индексы, триггеры), политики ссылаются только на tp_*.
--
-- Объём: 14 таблиц (из 21 в источнике). 7 таблиц НЕ переносим — см. блок
-- «ИСКЛЮЧЁННЫЕ ТАБЛИЦЫ» в конце файла (решение 2026-07-13).
--
-- Идемпотентно: create ... if not exists / create or replace / drop policy if exists.
-- Применять в SQL Editor HR DASHBOARD. Ретеншн логов — отдельной миграцией 0002_tp_retention.sql.
-- Портальные profiles/roles/projects/app_settings НЕ трогаются.
-- ============================================================================

-- SQL-функции (tp_has_role/tp_is_super_admin) создаём раньше их таблиц — отключаем
-- немедленную валидацию тел функций (как делает pg_dump). Действует на сессию SQL Editor.
set check_function_bodies = false;

-- ---------- ENUM ----------
do $$ begin
  create type public.tp_app_role as enum ('super_admin', 'pm', 'user', 'team_lead');
exception when duplicate_object then null; end $$;

-- ---------- FUNCTIONS (tp_ prefixed) ----------

create or replace function public.tp_update_updated_at_column() returns trigger
  language plpgsql set search_path to 'public' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.tp_calculate_total_time() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
begin
  new.total_time = coalesce(new.estimated_duration, 0) + coalesce(new.travel_time, 0);
  return new;
end;
$$;

create or replace function public.tp_enforce_first_task_travel_time() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
begin
  if new.stop_number = 1 then
    new.travel_time = 0;
  end if;
  return new;
end;
$$;

create or replace function public.tp_cleanup_old_batch_snapshots() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
begin
  delete from public.tp_task_batch_snapshots
  where id not in (
    select id from public.tp_task_batch_snapshots
    order by snapshot_date desc
    limit 7
  );
  return new;
end;
$$;

create or replace function public.tp_geocode_project_address(project_id_param uuid) returns jsonb
  language plpgsql security definer set search_path to 'public' as $$
begin
  return null; -- фактический геокодинг — в edge-функции
end;
$$;

create or replace function public.tp_geocode_team_address(team_id_param uuid) returns jsonb
  language plpgsql security definer set search_path to 'public' as $$
begin
  return null; -- фактический геокодинг — в edge-функции
end;
$$;

create or replace function public.tp_has_role(_user_id uuid, _role public.tp_app_role) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.tp_user_roles
    where user_id = _user_id and role = _role
  );
$$;

create or replace function public.tp_is_super_admin(_user_id uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.tp_user_roles
    where user_id = _user_id and role = 'super_admin'
  );
$$;

create or replace function public.tp_is_admin_user() returns boolean
  language plpgsql stable security definer set search_path to 'public' as $$
begin
  return false; -- как в оригинале (заглушка)
end;
$$;

-- Создаёт tp_profiles для нового auth.users и линкует с tp_teams по email.
-- Функция определена, но триггер на auth.users НЕ навешивается здесь (см. конец файла).
create or replace function public.tp_handle_new_user() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.tp_profiles (user_id, first_name, last_name, email)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    new.email
  )
  on conflict (user_id) do nothing;

  update public.tp_profiles
  set team_id = (
    select id from public.tp_teams
    where lower(email) = lower(new.email)
    limit 1
  )
  where user_id = new.id;

  return new;
end;
$$;

-- ---------- TABLES (порядок с учётом FK-зависимостей) ----------

create table if not exists public.tp_teams (
  id uuid default gen_random_uuid() primary key,
  airtable_id text unique,
  name text not null,
  email text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  address text,
  coordinates jsonb,
  latitude numeric,
  longitude numeric,
  slack_id text,
  account_status text default 'pending'::text,
  account_error text,
  account_synced_at timestamptz
);

create table if not exists public.tp_projects (
  id uuid default gen_random_uuid() primary key,
  airtable_id text unique,
  name text not null,
  address text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  project_manager text,
  coordinates jsonb,
  latitude numeric,
  longitude numeric,
  slack_id text,
  is_active boolean default true not null
);

create table if not exists public.tp_skills (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  created_at timestamptz default now() not null,
  description text,
  category text
);

create table if not exists public.tp_task_types (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  description text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create table if not exists public.tp_travel_cache (
  from_address text not null,
  to_address text not null,
  minutes integer not null,
  updated_at timestamptz default now() not null,
  primary key (from_address, to_address)
);

create table if not exists public.tp_ai_teams_schedule (
  id bigint generated by default as identity primary key,
  created_at timestamptz default now() not null,
  output_data jsonb,
  "request_ID" text,
  input_tasks jsonb,
  input_total text,
  input_unavailable_teams jsonb,
  input_teams jsonb,
  input_skills jsonb,
  input_body jsonb
);

create table if not exists public.tp_ai_settings (
  id uuid default gen_random_uuid() primary key,
  prompt_text text not null,
  setting_name text default 'scheduling_prompt'::text not null,
  is_active boolean default true not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  human_prompt_description text default 'Enter your prompt for ChatGPT to generate a schedule for your tasks. For example: ''Schedule these tasks for the next 2 weeks, prioritizing high-priority items and grouping tasks by location to minimize travel time.'''::text
);

create table if not exists public.tp_sync_logs (
  id uuid default gen_random_uuid() primary key,
  sync_type text not null,
  started_at timestamptz default now() not null,
  completed_at timestamptz,
  status text default 'in_progress'::text not null,
  records_synced integer default 0,
  error_message text,
  created_at timestamptz default now() not null
);

create table if not exists public.tp_task_batch_snapshots (
  id uuid default gen_random_uuid() primary key,
  batch_id text not null unique,
  tasks_data jsonb not null,
  snapshot_date timestamptz default now() not null,
  total_tasks integer default 0 not null,
  created_at timestamptz default now() not null
);

create table if not exists public.tp_app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now() not null,
  updated_by uuid references auth.users(id)
);

create table if not exists public.tp_profiles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  email text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  team_id uuid references public.tp_teams(id),
  initial_password text
);

create table if not exists public.tp_user_roles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.tp_app_role not null,
  created_at timestamptz default now(),
  unique (user_id, role)
);

create table if not exists public.tp_tasks (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text,
  required_skills text[],
  estimated_duration numeric(5,2),
  priority integer default 5,
  status text default 'requested'::text not null,
  scheduled_date date,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  address text,
  project_manager text,
  team_id uuid,
  skill_requirements jsonb default '[]'::jsonb,
  created_by text,
  additional_stop jsonb,
  task_type text,
  scheduled_time jsonb,
  project_id uuid references public.tp_projects(id),
  travel_time numeric,
  total_time numeric,
  stop_number integer,
  schedule_prompt text,
  additional_stop_duration numeric default 30,
  skills_from_ia jsonb default '[]'::jsonb,
  completed boolean default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  request_task_id uuid,
  constraint tp_tasks_status_check check ((status = any (array['requested'::text, 'proposed'::text, 'scheduled'::text, 'completed'::text])))
);

create table if not exists public.tp_team_availability (
  id uuid default gen_random_uuid() primary key,
  team_id uuid not null references public.tp_teams(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  created_by uuid references auth.users(id),
  constraint tp_valid_date_range check ((end_date >= start_date))
);

-- ---------- INDEXES ----------
create index if not exists tp_idx_profiles_email on public.tp_profiles using btree (email) where (email is not null);
create index if not exists tp_idx_projects_airtable_id on public.tp_projects using btree (airtable_id);
create index if not exists tp_idx_projects_is_active on public.tp_projects using btree (is_active);
create index if not exists tp_idx_projects_slack_id on public.tp_projects using btree (slack_id);
create index if not exists tp_idx_sync_logs_completed_at on public.tp_sync_logs using btree (completed_at desc);
create index if not exists tp_idx_sync_logs_sync_type on public.tp_sync_logs using btree (sync_type);
create index if not exists tp_idx_task_batch_snapshots_batch_id on public.tp_task_batch_snapshots using btree (batch_id);
create index if not exists tp_idx_task_batch_snapshots_date on public.tp_task_batch_snapshots using btree (snapshot_date desc);
create index if not exists tp_idx_tasks_completed on public.tp_tasks using btree (completed);
create index if not exists tp_idx_tasks_request_task_id on public.tp_tasks using btree (request_task_id);
create index if not exists tp_idx_team_availability_dates on public.tp_team_availability using btree (start_date, end_date);
create index if not exists tp_idx_team_availability_team_id on public.tp_team_availability using btree (team_id);
create index if not exists tp_idx_teams_email on public.tp_teams using btree (email) where (email is not null);

-- ---------- TRIGGERS ----------
drop trigger if exists tp_set_first_task_travel_time on public.tp_tasks;
create trigger tp_set_first_task_travel_time before insert or update of stop_number, travel_time on public.tp_tasks for each row execute function public.tp_enforce_first_task_travel_time();

drop trigger if exists tp_update_task_total_time on public.tp_tasks;
create trigger tp_update_task_total_time before insert or update on public.tp_tasks for each row execute function public.tp_calculate_total_time();

drop trigger if exists tp_update_tasks_updated_at on public.tp_tasks;
create trigger tp_update_tasks_updated_at before update on public.tp_tasks for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_trigger_cleanup_old_batch_snapshots on public.tp_task_batch_snapshots;
create trigger tp_trigger_cleanup_old_batch_snapshots after insert on public.tp_task_batch_snapshots for each row execute function public.tp_cleanup_old_batch_snapshots();

drop trigger if exists tp_update_ai_settings_updated_at on public.tp_ai_settings;
create trigger tp_update_ai_settings_updated_at before update on public.tp_ai_settings for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_update_teams_updated_at on public.tp_teams;
create trigger tp_update_teams_updated_at before update on public.tp_teams for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_update_profiles_updated_at on public.tp_profiles;
create trigger tp_update_profiles_updated_at before update on public.tp_profiles for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_update_projects_updated_at on public.tp_projects;
create trigger tp_update_projects_updated_at before update on public.tp_projects for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_update_task_types_updated_at on public.tp_task_types;
create trigger tp_update_task_types_updated_at before update on public.tp_task_types for each row execute function public.tp_update_updated_at_column();

drop trigger if exists tp_update_team_availability_updated_at on public.tp_team_availability;
create trigger tp_update_team_availability_updated_at before update on public.tp_team_availability for each row execute function public.tp_update_updated_at_column();

-- ---------- ROW LEVEL SECURITY ----------
alter table public.tp_ai_teams_schedule    enable row level security;
alter table public.tp_ai_settings          enable row level security;
alter table public.tp_app_settings         enable row level security;
alter table public.tp_profiles             enable row level security;
alter table public.tp_projects             enable row level security;
alter table public.tp_skills               enable row level security;
alter table public.tp_sync_logs            enable row level security;
alter table public.tp_task_batch_snapshots enable row level security;
alter table public.tp_task_types           enable row level security;
alter table public.tp_tasks                enable row level security;
alter table public.tp_team_availability    enable row level security;
alter table public.tp_teams                enable row level security;
alter table public.tp_travel_cache         enable row level security;
alter table public.tp_user_roles           enable row level security;

-- ---------- POLICIES ----------
-- «allow all» служебные таблицы
drop policy if exists "Allow all operations on AI_teams_schedule" on public.tp_ai_teams_schedule;
create policy "Allow all operations on AI_teams_schedule" on public.tp_ai_teams_schedule using (true);

drop policy if exists "Allow all operations on ai_settings" on public.tp_ai_settings;
create policy "Allow all operations on ai_settings" on public.tp_ai_settings using (true);

drop policy if exists "Allow all operations on sync_logs" on public.tp_sync_logs;
create policy "Allow all operations on sync_logs" on public.tp_sync_logs using (true);

drop policy if exists "Allow all operations on task_batch_snapshots" on public.tp_task_batch_snapshots;
create policy "Allow all operations on task_batch_snapshots" on public.tp_task_batch_snapshots using (true);

drop policy if exists "Allow all operations on team_availability" on public.tp_team_availability;
create policy "Allow all operations on team_availability" on public.tp_team_availability using (true);

-- teams
drop policy if exists "Allow all operations on crews" on public.tp_teams;
create policy "Allow all operations on crews" on public.tp_teams using (true);
drop policy if exists "PMs can do all operations on teams" on public.tp_teams;
create policy "PMs can do all operations on teams" on public.tp_teams using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Users can view teams" on public.tp_teams;
create policy "Users can view teams" on public.tp_teams for select using (true);

-- projects
drop policy if exists "PMs can do all operations on projects" on public.tp_projects;
create policy "PMs can do all operations on projects" on public.tp_projects using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Users can view projects" on public.tp_projects;
create policy "Users can view projects" on public.tp_projects for select using (true);

-- skills
drop policy if exists "PMs can do all operations on skills" on public.tp_skills;
create policy "PMs can do all operations on skills" on public.tp_skills using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Users can view skills" on public.tp_skills;
create policy "Users can view skills" on public.tp_skills for select using (true);

-- task_types
drop policy if exists "PMs can do all operations on task_types" on public.tp_task_types;
create policy "PMs can do all operations on task_types" on public.tp_task_types using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Users can view task_types" on public.tp_task_types;
create policy "Users can view task_types" on public.tp_task_types for select using (true);

-- tasks
drop policy if exists "PMs and super admins can do all operations on tasks" on public.tp_tasks;
create policy "PMs and super admins can do all operations on tasks" on public.tp_tasks
  using ((public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role) or public.tp_is_super_admin(auth.uid())));
drop policy if exists "Team leads can update completion status" on public.tp_tasks;
create policy "Team leads can update completion status" on public.tp_tasks for update
  using ((public.tp_has_role(auth.uid(), 'team_lead'::public.tp_app_role) and (status = 'scheduled'::text) and (team_id in (
    select tp_profiles.team_id from public.tp_profiles where (tp_profiles.user_id = auth.uid())))))
  with check ((public.tp_has_role(auth.uid(), 'team_lead'::public.tp_app_role) and (status = 'scheduled'::text) and (team_id in (
    select tp_profiles.team_id from public.tp_profiles where (tp_profiles.user_id = auth.uid())))));
drop policy if exists "Team leads can view their scheduled tasks" on public.tp_tasks;
create policy "Team leads can view their scheduled tasks" on public.tp_tasks for select
  using ((public.tp_has_role(auth.uid(), 'team_lead'::public.tp_app_role) and (status = 'scheduled'::text) and (team_id in (
    select tp_profiles.team_id from public.tp_profiles where (tp_profiles.user_id = auth.uid())))));

-- profiles
drop policy if exists "PMs can delete team_lead profiles only" on public.tp_profiles;
create policy "PMs can delete team_lead profiles only" on public.tp_profiles for delete
  using ((public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role) and (user_id in (
    select tp_user_roles.user_id from public.tp_user_roles where (tp_user_roles.role = 'team_lead'::public.tp_app_role)))));
drop policy if exists "PMs can update all profiles" on public.tp_profiles;
create policy "PMs can update all profiles" on public.tp_profiles for update using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "PMs can view all profiles" on public.tp_profiles;
create policy "PMs can view all profiles" on public.tp_profiles for select using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Super admins can delete any profile" on public.tp_profiles;
create policy "Super admins can delete any profile" on public.tp_profiles for delete using (public.tp_is_super_admin(auth.uid()));
drop policy if exists "Super admins can view all profiles" on public.tp_profiles;
create policy "Super admins can view all profiles" on public.tp_profiles for select using (public.tp_is_super_admin(auth.uid()));
drop policy if exists "System can insert profiles" on public.tp_profiles;
create policy "System can insert profiles" on public.tp_profiles for insert with check (true);
drop policy if exists "Users can update their own profile" on public.tp_profiles;
create policy "Users can update their own profile" on public.tp_profiles for update using ((user_id = auth.uid()));
drop policy if exists "Users can view their own profile" on public.tp_profiles;
create policy "Users can view their own profile" on public.tp_profiles for select using ((user_id = auth.uid()));

-- user_roles
drop policy if exists "PMs can delete team_lead roles only" on public.tp_user_roles;
create policy "PMs can delete team_lead roles only" on public.tp_user_roles for delete
  using ((public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role) and (role = 'team_lead'::public.tp_app_role)));
drop policy if exists "PMs can insert team_lead roles only" on public.tp_user_roles;
create policy "PMs can insert team_lead roles only" on public.tp_user_roles for insert
  with check ((public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role) and (role = 'team_lead'::public.tp_app_role)));
drop policy if exists "PMs can view all user roles" on public.tp_user_roles;
create policy "PMs can view all user roles" on public.tp_user_roles for select using (public.tp_has_role(auth.uid(), 'pm'::public.tp_app_role));
drop policy if exists "Super admins can delete any role" on public.tp_user_roles;
create policy "Super admins can delete any role" on public.tp_user_roles for delete using (public.tp_is_super_admin(auth.uid()));
drop policy if exists "Super admins can insert any role" on public.tp_user_roles;
create policy "Super admins can insert any role" on public.tp_user_roles for insert with check (public.tp_is_super_admin(auth.uid()));
drop policy if exists "Super admins can view all roles" on public.tp_user_roles;
create policy "Super admins can view all roles" on public.tp_user_roles for select using (public.tp_is_super_admin(auth.uid()));
drop policy if exists "Users can view their own roles" on public.tp_user_roles;
create policy "Users can view their own roles" on public.tp_user_roles for select using ((user_id = auth.uid()));

-- app_settings
drop policy if exists tp_app_settings_read on public.tp_app_settings;
create policy tp_app_settings_read on public.tp_app_settings for select to authenticated using (true);
drop policy if exists tp_app_settings_write on public.tp_app_settings;
create policy tp_app_settings_write on public.tp_app_settings to authenticated
  using ((exists (select 1 from public.tp_user_roles ur where ((ur.user_id = auth.uid()) and (ur.role = 'super_admin'::public.tp_app_role)))))
  with check ((exists (select 1 from public.tp_user_roles ur where ((ur.user_id = auth.uid()) and (ur.role = 'super_admin'::public.tp_app_role)))));

-- travel_cache
drop policy if exists tp_travel_cache_rw on public.tp_travel_cache;
create policy tp_travel_cache_rw on public.tp_travel_cache to authenticated using (true) with check (true);

-- ============================================================================
-- ⚠️ АВТО-СОЗДАНИЕ ПРОФИЛЯ (решение принять отдельно на Шаге 4)
-- В оригинале был триггер on auth.users → handle_new_user (создавал profile при регистрации).
-- Здесь НЕ навешиваем: auth.users общий для всего портала. Если нужно авто-создание tp_profiles —
-- раскомментировать (имя уникальное, чтобы не конфликтовать с портальным on_auth_user_created):
--
-- drop trigger if exists on_auth_user_created_tp on auth.users;
-- create trigger on_auth_user_created_tp after insert on auth.users
--   for each row execute function public.tp_handle_new_user();
--
-- ============================================================================
-- ИСКЛЮЧЁННЫЕ ТАБЛИЦЫ (решение 2026-07-13) — НЕ переносим:
--   • async_jobs            — пустая, паттерн async-очереди не используется → удалено
--   • streaming_logs        — пустая; логи стрима ChatGPT уходят в localStorage → удалено
--   • add_prompt_responses  — пустая, экспериментальная → удалено
--   • test_proposal_payload_base — тестовая свалка (233 тест-строки) → удалено
--   • task_completion_history \
--   • task_notes             > фича «user/бригадир: заметки, фото, история выполнения задач».
--   • task_photos           /  Пустые; выносим в отдельную доработку с нормальными именами
--                              (напр. user_notes_for_tasks с явной связью на tp_tasks) + бакет
--                              для фото. Проектируем/тестируем на этапе user-функционала.
--                              См. docs/TASK-PLANNER-MIGRATION.md.
-- ============================================================================
