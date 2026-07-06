-- Портал «My Applications»: whitelist-юзеры, роли, приложения, доступы + RLS.
-- ⚠️ Референс-схема для ЧИСТОГО проекта. Мы подключаемся к существующему
-- Lovable-Supabase — перед применением сверить с реальной схемой (см. README §Schema);
-- расхождения адаптируются в src/services/data.ts + src/domain/types.ts.

create extension if not exists pgcrypto;

-- ---------------- Таблицы ----------------

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_admin    boolean not null default false, -- открывает User Management и управление users/roles
  created_at  timestamptz not null default now()
);

create table if not exists public.applications (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,  -- слаг = имя папки в apps/*
  name       text not null,         -- заголовок карточки
  url        text,                  -- субдомен приложения; null = ещё не задеплоено
  sort_order int  not null default 100
);

create table if not exists public.role_applications (
  role_id        uuid not null references public.roles(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  primary key (role_id, application_id)
);

-- Whitelist: админ заводит email заранее; auth_user_id линкуется при первом входе.
create table if not exists public.profiles (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email        text not null,
  full_name    text,
  role_id      uuid references public.roles(id) on delete set null,
  created_at   timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_key on public.profiles (lower(email));

-- ---------------- Helpers ----------------

create or replace function public.jwt_email()
returns text language sql stable as
$$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- security definer: обходит RLS profiles, иначе рекурсия политики самой на себя
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as
$$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id
    where r.is_admin
      and (p.auth_user_id = auth.uid() or lower(p.email) = public.jwt_email())
  )
$$;

-- Линковка whitelist-записи при первом Google-входе
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as
$$
begin
  update public.profiles
     set auth_user_id = new.id
   where auth_user_id is null
     and lower(email) = lower(coalesce(new.email, ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Не-админ может править только своё имя (не role_id/email/линковку)
create or replace function public.protect_profile_columns()
returns trigger language plpgsql security definer set search_path = public as
$$
begin
  if not public.is_admin() and (
    new.role_id      is distinct from old.role_id or
    new.email        is distinct from old.email or
    new.auth_user_id is distinct from old.auth_user_id
  ) then
    raise exception 'Only admins can change role, email or account linking';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- ---------------- RLS ----------------

alter table public.roles             enable row level security;
alter table public.applications      enable row level security;
alter table public.role_applications enable row level security;
alter table public.profiles          enable row level security;

-- Справочники читают все залогиненные (нужны для карточек и бейджей ролей)
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select to authenticated using (true);

drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications
  for select to authenticated using (true);

drop policy if exists role_applications_select on public.role_applications;
create policy role_applications_select on public.role_applications
  for select to authenticated using (true);

-- Пишет только админ
drop policy if exists roles_admin_write on public.roles;
create policy roles_admin_write on public.roles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists applications_admin_write on public.applications;
create policy applications_admin_write on public.applications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists role_applications_admin_write on public.role_applications;
create policy role_applications_admin_write on public.role_applications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Profiles: админ видит/правит всех; юзер видит и правит только себя
-- (защита колонок — триггером protect_profile_columns)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.is_admin() or auth_user_id = auth.uid() or lower(email) = public.jwt_email());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (public.is_admin() or auth_user_id = auth.uid() or lower(email) = public.jwt_email())
  with check (true);

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated using (public.is_admin());
