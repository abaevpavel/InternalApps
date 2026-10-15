-- Task Planner: люди поверх справочника — тестовый PM.
--
-- Список людей для выбора PM (tp_people, миграция 0032) — синхронизированная копия Contacts
-- Directory из Airtable (receipt_matcher_employees). Тестового аккаунта портала там нет и
-- быть не должно, а тестировать смену PM и «свои задачи» PM нужно под ним.
--
-- tp_people_extra — люди, добавленные вручную поверх синка. Синк эту таблицу не трогает.
-- В списке они показываются с пометкой (note), например «Todor3D Dev (test PM)».
-- Убрать человека — удалить строку; изменения попадают в историю модуля.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

create table if not exists public.tp_people_extra (
  email      text primary key check (email = lower(btrim(email)) and email <> ''),
  full_name  text not null,
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.tp_people_extra is
  'Люди для выбора PM поверх синка Contacts Directory (тестовые аккаунты). Читается через tp_people().';

-- Читать и писать напрямую не может никто: список отдаёт tp_people(), правка — SQL.
alter table public.tp_people_extra enable row level security;
revoke all on public.tp_people_extra from anon, authenticated;

-- История модуля (0034): добавление и удаление людей видно в History.
drop trigger if exists portal_audit on public.tp_people_extra;
create trigger portal_audit after insert or update or delete on public.tp_people_extra
  for each row execute function public.portal_audit_row('/task-planner', 'email');

insert into public.tp_people_extra (email, full_name, note)
values ('todor.3d@basementremodeling.com', 'Todor3D Dev', 'test PM')
on conflict (email) do update set full_name = excluded.full_name, note = excluded.note;

-- Справочник + люди поверх него. Человек из справочника важнее ручной строки.
create or replace function public.tp_people()
returns table (full_name text, email text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.tp_sees_all_tasks() then
    raise exception 'Not allowed to read the people directory' using errcode = '42501';
  end if;
  return query
  select p.full_name, p.email from (
    select e.full_name::text as full_name, lower(e.email)::text as email
    from public.receipt_matcher_employees e
    where e.active and e.email is not null and btrim(e.email) <> ''
    union all
    select (x.full_name || coalesce(' (' || x.note || ')', ''))::text, x.email
    from public.tp_people_extra x
    where not exists (
      select 1 from public.receipt_matcher_employees e
      where e.active and lower(e.email) = x.email
    )
  ) p
  order by p.full_name;
end $$;

-- Смена PM (0034): человек берётся из того же списка.
create or replace function public.tp_set_task_pm(p_task_id uuid, p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text;
  v_count integer;
begin
  if not public.tp_has_module_role('pm') then
    raise exception 'Not allowed to change the PM of this task' using errcode = '42501';
  end if;

  select p.full_name into v_name from public.tp_people() p where p.email = v_email limit 1;
  if v_name is null then
    raise exception 'This person is not in the people directory' using errcode = '22023';
  end if;

  if not exists (select 1 from public.tp_tasks where id = p_task_id) then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  update public.tp_tasks
  set pm_email = v_email, project_manager = v_name
  where (id = p_task_id or request_task_id = p_task_id)
    and pm_email is distinct from v_email;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Пометка на экране ролей (App Settings → Roles): кто из людей добавлен поверх синка.
-- Только email и пометка тестовых аккаунтов — отдаётся любому вошедшему.
create or replace function public.tp_people_extra_notes()
returns table (email text, note text)
language sql
stable
security definer
set search_path = public
as $$
  select x.email, x.note from public.tp_people_extra x
$$;

revoke all on function public.tp_people_extra_notes() from public;
grant execute on function public.tp_people_extra_notes() to authenticated;

commit;
