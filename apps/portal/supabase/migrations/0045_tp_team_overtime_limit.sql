-- Task Planner: лимит переработки у каждой бригады (BAS-1445).
--
--   • tp_teams.overtime_limit_minutes — сколько минут сверх 8 часов бригаде можно работать в день.
--     По умолчанию 120 — прежнее общее правило «не больше 10 часов». Больше лимита AI не ставит
--     (решение Vlad 24.10.2026). Портал передаёт лимит каждой бригады в n8n.
--   • Менять лимит — Admin, PM, Schedule Manager (manage_overtime). Таблица бригад открыта на запись
--     с 0001 (синк из Airtable, Directories), поэтому именно это поле стережёт триггер: пользователь
--     без роли поменять его не может. Сервисные вызовы (синк, auth.uid() пустой) не затрагиваются.
--   • tp_set_team_overtime_limit — сохранить лимит с экрана Teams Availability.
--   • История: tp_teams уже пишется в portal_audit_log (0034) — смена лимита видна в History
--     с автором, старым и новым значением.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

alter table public.tp_teams add column if not exists overtime_limit_minutes integer not null default 120;

alter table public.tp_teams drop constraint if exists tp_teams_overtime_limit_check;
alter table public.tp_teams add constraint tp_teams_overtime_limit_check
  check (overtime_limit_minutes between 0 and 480);

comment on column public.tp_teams.overtime_limit_minutes is
  'Лимит переработки бригады, минут сверх 8 часов (480). Рабочий день не длиннее 480 + лимит (BAS-1445).';

create or replace function public.tp_can_manage_overtime()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tp_has_module_role('admin')
      or public.tp_has_module_role('pm')
      or public.tp_has_module_role('schedule_manager')
$$;

revoke all on function public.tp_can_manage_overtime() from public;
grant execute on function public.tp_can_manage_overtime() to authenticated;

create or replace function public.tp_guard_team_overtime_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.overtime_limit_minutes is distinct from old.overtime_limit_minutes
     and auth.uid() is not null
     and not public.tp_can_manage_overtime() then
    raise exception 'Only an Admin, a PM or a Schedule Manager can change the overtime limit'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tp_guard_team_overtime_limit on public.tp_teams;
create trigger tp_guard_team_overtime_limit
  before update of overtime_limit_minutes on public.tp_teams
  for each row execute function public.tp_guard_team_overtime_limit();

create or replace function public.tp_set_team_overtime_limit(p_team_id uuid, p_minutes integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.tp_can_manage_overtime() then
    raise exception 'Only an Admin, a PM or a Schedule Manager can change the overtime limit'
      using errcode = '42501';
  end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 480 then
    raise exception 'The overtime limit must be between 0 and 8 hours' using errcode = '22023';
  end if;
  update public.tp_teams set overtime_limit_minutes = p_minutes where id = p_team_id;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.tp_set_team_overtime_limit(uuid, integer) from public;
grant execute on function public.tp_set_team_overtime_limit(uuid, integer) to authenticated;

commit;
