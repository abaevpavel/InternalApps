-- Портал: View As — посмотреть портал глазами другого пользователя (роль Developer, Vlad 24.10.2026).
--
-- Как устроено:
--   • edge `view-as` (action start) проверяет, что вызывающий — Developer, открывает сессию
--     выбранного пользователя (magic link → verifyOtp на сервере, письма не уходят) и пишет её
--     в portal_view_as_sessions: кто, кого, когда, id сессии.
--   • Портал на время переключается на эту сессию — меню, приложения, роли модулей и все данные
--     (RLS) ровно как у этого человека. Политики доступа менять не нужно.
--   • Только просмотр: любая запись в public из сессии, которая есть в журнале, отклоняется
--     (триггер на каждой таблице), загрузка/удаление файлов — тоже (restrictive policy storage).
--     Сервисные вызовы (edge, синки) сессии не несут и не затрагиваются.
--   • Exit: edge (action end) отмечает конец, клиент закрывает эту сессию только у себя
--     (signOut scope local) и возвращает свою.
--
-- Новые таблицы триггер не получают сами: после их создания вызвать
--   select public.portal_attach_view_as_guard();
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

create table if not exists public.portal_view_as_sessions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null unique,
  developer_id   uuid not null,
  developer_email text,
  target_user_id uuid not null,
  target_email   text,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz
);

comment on table public.portal_view_as_sessions is
  'Журнал View As: сессии, открытые разработчиком под другим пользователем. Из них запись запрещена.';

create or replace function public.user_has_developer_role(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = $1 and r.name = 'Developer'
  )
$$;

revoke all on function public.user_has_developer_role(uuid) from public;
grant execute on function public.user_has_developer_role(uuid) to authenticated;

alter table public.portal_view_as_sessions enable row level security;
drop policy if exists "Developers read view-as log" on public.portal_view_as_sessions;
create policy "Developers read view-as log" on public.portal_view_as_sessions
  for select using (public.user_has_developer_role(auth.uid()));

-- Текущая сессия открыта через View As?
create or replace function public.portal_view_as_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.portal_view_as_sessions s
    where s.session_id = nullif(auth.jwt()->>'session_id', '')::uuid
  )
$$;

revoke all on function public.portal_view_as_active() from public;
grant execute on function public.portal_view_as_active() to authenticated, anon;

create or replace function public.portal_view_as_readonly()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.portal_view_as_active() then
    raise exception 'View As is read-only: changes are not saved' using errcode = '42501';
  end if;
  return null;
end $$;

-- Повесить запрет записи на все таблицы public (кроме самого журнала). Возвращает пропущенные.
create or replace function public.portal_attach_view_as_guard()
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  skipped text[] := '{}';
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'portal_view_as_sessions'
  loop
    begin
      execute format('drop trigger if exists portal_view_as_readonly on public.%I', t.relname);
      execute format(
        'create trigger portal_view_as_readonly before insert or update or delete on public.%I
           for each statement execute function public.portal_view_as_readonly()', t.relname);
    exception when others then
      skipped := skipped || t.relname;
    end;
  end loop;
  return skipped;
end $$;

revoke all on function public.portal_attach_view_as_guard() from public;

select public.portal_attach_view_as_guard();

-- Файлы (фото задач, вложения): в режиме View As ни загрузить, ни удалить.
do $$
begin
  execute 'drop policy if exists "View As is read-only" on storage.objects';
  execute 'drop policy if exists "View As cannot upload" on storage.objects';
  execute 'drop policy if exists "View As cannot change files" on storage.objects';
  execute 'drop policy if exists "View As cannot delete files" on storage.objects';
  execute 'create policy "View As cannot upload" on storage.objects as restrictive
             for insert to authenticated with check (not public.portal_view_as_active())';
  execute 'create policy "View As cannot change files" on storage.objects as restrictive
             for update to authenticated using (not public.portal_view_as_active())';
  execute 'create policy "View As cannot delete files" on storage.objects as restrictive
             for delete to authenticated using (not public.portal_view_as_active())';
exception when others then
  raise notice 'storage policies skipped: %', sqlerrm;
end $$;

commit;
