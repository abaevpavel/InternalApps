-- Task Planner: Lead Carpenter видит только свою работу (BAS-1511, LC View).
--
-- Было (проверено по pg_policies 2026-10-16):
--  - tp_tasks_team_read отдавал Lead Carpenter задачи своей бригады в ЛЮБОМ статусе —
--    requested / proposed тоже, то есть сторону планирования;
--  - tp_can_act_on_task (на нём журнал, фото, Complete, заметки) — тоже без статуса;
--  - tp_ai_teams_schedule и tp_team_availability читал любой вошедший: в результате AI
--    лежат задачи всех бригад, в доступности — график всех бригад.
-- Стало:
--  - Lead Carpenter читает и трогает только задачи своей бригады со status = 'scheduled';
--  - результат AI и доступность бригад читают только Admin / PM / Schedule Manager
--    (tp_sees_all_tasks) — те же, кто видит экраны Tasks и Teams Availability.
--    n8n пишет результат AI сервисным ключом, RLS его не касается;
--  - фото в закрытую задачу добавить нельзя (удалить уже было нельзя, 0033).
--
-- Применять: Supabase CLI. Идемпотентно: повторный прогон ничего не меняет.

begin;

-- 1) Задачи бригады — только утверждённого расписания.
drop policy if exists tp_tasks_team_read on public.tp_tasks;
create policy tp_tasks_team_read on public.tp_tasks
  for select to authenticated
  using (status = 'scheduled' and team_id is not null and team_id = public.tp_my_team_id());

-- 2) Действия и просмотр журнала / фото бригадиром — тоже только у scheduled.
create or replace function public.tp_can_act_on_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tp_tasks t
    where t.id = p_task_id
      and t.status = 'scheduled'
      and t.team_id is not null
      and t.team_id = public.tp_my_team_id()
  )
$$;

-- 3) Результат AI и доступность бригад — сторона планирования.
drop policy if exists tp_read_authenticated on public.tp_ai_teams_schedule;
create policy tp_read_authenticated on public.tp_ai_teams_schedule
  for select to authenticated
  using (public.tp_sees_all_tasks());

drop policy if exists tp_read_authenticated on public.tp_team_availability;
create policy tp_read_authenticated on public.tp_team_availability
  for select to authenticated
  using (public.tp_sees_all_tasks());

-- 4) Фото в закрытую задачу — нельзя.
create or replace function public.tp_add_task_photo(p_task_id uuid, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid;
begin
  if not public.tp_can_act_on_task(p_task_id) then
    raise exception 'Not allowed to add photos to this task' using errcode = '42501';
  end if;
  if (select execution_status from public.tp_tasks where id = p_task_id) = 'closed' then
    raise exception 'The task is closed, its photos cannot be changed' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_path, '')), '') is null then
    raise exception 'Photo path cannot be empty' using errcode = '22023';
  end if;

  v_event := public.tp_log_task_event(p_task_id, 'photo', null, null, null);
  insert into public.tp_task_photos (task_id, event_id, path, created_by)
  values (p_task_id, v_event, p_path, auth.uid());
  return v_event;
end $$;

commit;
