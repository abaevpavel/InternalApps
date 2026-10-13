-- Task Planner: PM задачи — явное поле `pm_email`.
--
-- Правило (Владислав, 13.10.2026):
--   • проектная задача — по умолчанию PM проекта (имя из Airtable → email по справочнику);
--   • Other Task — по умолчанию автор;
--   • в Create Task PM можно выбрать вручную из людей Contacts Directory.
-- «Свои задачи» PM (My Tasks → As PM) считаются по pm_email.
--
-- Список людей — синхронизированная копия Contacts Directory «All employees»
-- (receipt_matcher_employees, синк sync-receipt-employees). Таблица принадлежит Receipts Matcher
-- и закрыта его RLS, поэтому Task Planner читает её через функцию tp_people() — без правок
-- чужих политик. Вызвать может тот, кто видит все задачи модуля (Admin / PM / Schedule Manager).
--
-- Применять: Supabase CLI или SQL Editor. Идемпотентно.

begin;

alter table public.tp_tasks add column if not exists pm_email text;
create index if not exists tp_tasks_pm_email on public.tp_tasks (lower(pm_email));

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
  select e.full_name::text, lower(e.email)::text
  from public.receipt_matcher_employees e
  where e.active and e.email is not null and btrim(e.email) <> ''
  order by e.full_name;
end $$;

revoke all on function public.tp_people() from public;
grant execute on function public.tp_people() to authenticated;

-- Заполнить PM у существующих задач: проектные — по PM проекта (имя → email),
-- остальные — по автору. Уже заданный pm_email не трогаем.
update public.tp_tasks t
set pm_email = lower(e.email)
from public.tp_projects p
join public.receipt_matcher_employees e on lower(btrim(e.full_name)) = lower(btrim(p.project_manager))
where t.pm_email is null and t.project_id = p.id and p.project_manager is not null;

update public.tp_tasks t
set pm_email = lower(u.email)
from auth.users u
where t.pm_email is null and t.project_id is null and t.created_by = u.id::text;

commit;
