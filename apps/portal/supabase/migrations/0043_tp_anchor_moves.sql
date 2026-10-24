-- Task Planner: якорь (Exact time) без ограничений, проверка времени после переноса (BAS-1436).
--
--   • tp_move_task получает третий необязательный параметр p_anchor:
--       null    — время не трогаем; если у задачи якорь, ставим пометку anchor_moved_from
--                 (с какой даты перенесли) — в Requested её подсвечивают, пока время не проверят;
--       ''      — снять якорь (задача без точного времени);
--       'HH:MM' — новое точное время, пометка не нужна.
--     Вызов с двумя параметрами работает как раньше (параметр по умолчанию null).
--   • tp_set_task_anchor — поменять или подтвердить время якоря у задачи в Requested; снимает пометку.
--     PM — время своей задачи всегда (правка задачи, BAS-1509). Schedule Manager — только у задачи
--     с пометкой «перенесли с якорем» (часть переноса, BAS-1436), в остальном время не правит.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

alter table public.tp_tasks add column if not exists anchor_moved_from date;
comment on column public.tp_tasks.anchor_moved_from is
  'Задачу с якорем перенесли с этой даты, время ещё не проверили (BAS-1436). null — проверять нечего.';

-- scheduled_time якоря: ключи и заявки ({type, time}), и Create Task ({anchor, anchor_time, start})
create or replace function public.tp_anchor_time_json(p_time text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('type', 'exact', 'time', p_time, 'anchor', true, 'anchor_time', p_time, 'start', p_time)
$$;

create or replace function public.tp_is_anchor(p_st jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(p_st->>'anchor' = 'true' or p_st->>'type' = 'exact', false)
$$;

-- Права на задачу: Schedule Manager — любую; PM — только свою (pm_email или автор). Как в 0041.
create or replace function public.tp_assert_can_move(v_task public.tp_tasks)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sm    boolean := public.tp_has_module_role('schedule_manager');
  v_pm    boolean := public.tp_has_module_role('pm');
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if not (v_sm or v_pm) then
    raise exception 'Not allowed to move tasks' using errcode = '42501';
  end if;
  if not v_sm and not (lower(coalesce(v_task.pm_email, '')) = v_email
                       or coalesce(v_task.created_by, '') = auth.uid()::text) then
    raise exception 'A PM can change only their own tasks' using errcode = '42501';
  end if;
end $$;

drop function if exists public.tp_move_task(uuid, date);

create or replace function public.tp_move_task(p_task_id uuid, p_date date, p_anchor text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tp_tasks%rowtype;
  v_st   jsonb;
begin
  if p_date is null then
    raise exception 'Date is required' using errcode = '22023';
  end if;
  if p_anchor is not null and p_anchor <> '' and p_anchor !~ '^\d{2}:\d{2}$' then
    raise exception 'Time must be HH:MM' using errcode = '22023';
  end if;

  select * into v_task from public.tp_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  perform public.tp_assert_can_move(v_task);
  if v_task.execution_status <> 'pending' then
    raise exception 'A completed or closed task cannot be moved' using errcode = '22023';
  end if;
  if v_task.request_task_id is not null then
    raise exception 'This is a copy from the old test mode and cannot be moved' using errcode = '22023';
  end if;
  if v_task.status = 'requested' and v_task.ai_request_id is not null
     and v_task.ai_sent_at > now() - interval '10 minutes' then
    raise exception 'The task is waiting for the AI answer' using errcode = '22023';
  end if;

  -- время заявки (до AI), как в 0041
  v_st := case when v_task.scheduled_time ? 'requested'
               then nullif(v_task.scheduled_time->'requested', 'null'::jsonb)
               else v_task.scheduled_time end;
  if p_anchor = '' then
    v_st := null;
  elsif p_anchor is not null then
    v_st := public.tp_anchor_time_json(p_anchor);
  end if;

  update public.tp_tasks
     set scheduled_date = p_date,
         status = 'requested',
         team_id = case when v_task.status = 'requested' then v_task.team_id else v_task.requested_team_id end,
         scheduled_time = v_st,
         stop_number = null,
         travel_time = null,
         requested_team_id = null,
         ai_warnings = null,
         ai_request_id = null,
         ai_sent_at = null,
         -- якорь перенесли, а время не выбрали — пусть проверят; дата — та, с которой перенесли
         anchor_moved_from = case
           when p_anchor is null and public.tp_is_anchor(v_st) and p_date <> v_task.scheduled_date
             then coalesce(v_task.anchor_moved_from, v_task.scheduled_date)
           else null end
   where id = p_task_id;
end $$;

revoke all on function public.tp_move_task(uuid, date, text) from public;
grant execute on function public.tp_move_task(uuid, date, text) to authenticated;

-- Поменять ('HH:MM'), снять ('') или подтвердить (null) время якоря у задачи в Requested.
create or replace function public.tp_set_task_anchor(p_task_id uuid, p_anchor text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tp_tasks%rowtype;
begin
  if p_anchor is not null and p_anchor <> '' and p_anchor !~ '^\d{2}:\d{2}$' then
    raise exception 'Time must be HH:MM' using errcode = '22023';
  end if;
  select * into v_task from public.tp_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  perform public.tp_assert_can_move(v_task);
  -- Правка задачи — только PM (матрица BAS-1509). Schedule Manager решает про время только
  -- в рамках своего переноса: пока висит пометка «перенесли с якорем».
  if not public.tp_has_module_role('pm') and v_task.anchor_moved_from is null then
    raise exception 'Only a PM can change the exact time of a task' using errcode = '42501';
  end if;
  if v_task.status <> 'requested' then
    raise exception 'The time can be changed only in Requested' using errcode = '22023';
  end if;
  if v_task.ai_request_id is not null and v_task.ai_sent_at > now() - interval '10 minutes' then
    raise exception 'The task is waiting for the AI answer' using errcode = '22023';
  end if;

  update public.tp_tasks
     set scheduled_time = case
           when p_anchor is null then scheduled_time
           when p_anchor = '' then null
           else public.tp_anchor_time_json(p_anchor) end,
         anchor_moved_from = null
   where id = p_task_id;
end $$;

revoke all on function public.tp_set_task_anchor(uuid, text) from public;
grant execute on function public.tp_set_task_anchor(uuid, text) to authenticated;

revoke all on function public.tp_assert_can_move(public.tp_tasks) from public;

commit;
