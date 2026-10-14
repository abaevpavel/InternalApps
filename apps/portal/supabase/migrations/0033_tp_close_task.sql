-- Task Planner: закрытие задачи из списков PM (BAS-1431, сюда же влита BAS-1432).
--
-- Было: PM на экране Approvals подтверждал выполненную задачу (approved) или возвращал её
-- бригаде (rework → снова pending).
-- Стало: у проверки один исход — задача закрывается (execution_status = 'closed') и больше
-- не возвращается в прежнее состояние. Результат проверки — отметка Task Accepted
-- (tp_tasks.task_accepted). Закрыть можно из Completed (основной путь) и из Uncompleted
-- (бригада не отметила, а работа сделана). Возврат на доработку убран.
--
--   • tp_close_task(task, accepted, comment) — единственный способ закрыть; PM модуля;
--   • tp_add_review_comment(task, comment) — комментарий PM без смены статуса. Комментарии —
--     события журнала tp_task_events: append-only, правки и удаления нет ни у кого;
--   • tp_tasks.origin_task_id — из какой задачи создана задача «на другой день» после
--     непринятой работы. Только бэкенд, в интерфейсе не показывается;
--   • триггер: execution_status меняется только функциями исполнения, у закрытой задачи
--     нельзя вернуть статус и сменить дату (кроме service_role — синки, ручные правки).
--
-- Старые значения: approved → closed с task_accepted = true, rework → pending. На момент
-- написания в боевой БД таких строк нет (33 pending, 1 completed), перевод — подстраховка.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

-- ============================================================
-- 1) Колонки
-- ============================================================
alter table public.tp_tasks add column if not exists task_accepted boolean;
alter table public.tp_tasks add column if not exists closed_at timestamptz;
alter table public.tp_tasks add column if not exists closed_by uuid references auth.users(id) on delete set null;
alter table public.tp_tasks add column if not exists origin_task_id uuid references public.tp_tasks(id) on delete set null;

comment on column public.tp_tasks.task_accepted is
  'Результат проверки PM при закрытии (BAS-1431): true — работа принята, false — нет. null — задача не закрыта.';
comment on column public.tp_tasks.origin_task_id is
  'Задача, после непринятой работы по которой создана эта (BAS-1431). Только бэкенд.';

-- ============================================================
-- 2) Ось исполнения: pending → completed → closed (closed — финал)
-- ============================================================
alter table public.tp_tasks drop constraint if exists tp_tasks_execution_status_check;

update public.tp_tasks
set execution_status = 'closed', task_accepted = true, closed_at = coalesce(closed_at, now())
where execution_status = 'approved';

update public.tp_tasks set execution_status = 'pending' where execution_status = 'rework';

alter table public.tp_tasks
  add constraint tp_tasks_execution_status_check
  check (execution_status in ('pending', 'completed', 'closed'));

comment on column public.tp_tasks.execution_status is
  'Ось исполнения (независима от status): pending → completed → closed; closed можно поставить и из pending. closed — финал. Меняется только tp_complete_task / tp_close_task.';

-- Журнал: новые события. approved / rework остаются для старых записей.
alter table public.tp_task_events drop constraint if exists tp_task_events_type_check;
alter table public.tp_task_events add constraint tp_task_events_type_check check (
  event_type in ('completed', 'closed', 'comment', 'note', 'photo', 'photo_removed', 'approved', 'rework')
);

-- Роль автора события: проверка и комментарий проверки — PM, остальное — Lead Carpenter.
create or replace function public.tp_actor_role(p_event_type text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p_event_type in ('closed', 'comment', 'approved', 'rework') then 'pm' else 'lead_carpenter' end
$$;

-- ============================================================
-- 3) Защита оси исполнения
-- ============================================================
-- Политика tp_tasks_update даёт PM правку строки целиком, поэтому статус исполнения
-- сторожит триггер: менять его могут только функции исполнения (они ставят флаг
-- tp.execution_rpc на свою транзакцию) и service_role.
create or replace function public.tp_tasks_guard_execution()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if new.execution_status is distinct from old.execution_status
     and coalesce(current_setting('tp.execution_rpc', true), '') <> 'on' then
    raise exception 'Execution status changes only through the task actions' using errcode = '42501';
  end if;
  if old.execution_status = 'closed' then
    if new.execution_status is distinct from 'closed' then
      raise exception 'A closed task cannot be reopened' using errcode = '22023';
    end if;
    if new.scheduled_date is distinct from old.scheduled_date then
      raise exception 'The date of a closed task cannot be changed' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tp_tasks_guard_execution on public.tp_tasks;
create trigger tp_tasks_guard_execution
  before update on public.tp_tasks
  for each row execute function public.tp_tasks_guard_execution();

-- ============================================================
-- 4) Действия
-- ============================================================

-- Lead Carpenter отмечает задачу выполненной (тело как в 0007, плюс флаг для триггера).
create or replace function public.tp_complete_task(p_task_id uuid, p_comment text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_status text;
begin
  if not public.tp_can_act_on_task(p_task_id) then
    raise exception 'Not allowed to complete this task' using errcode = '42501';
  end if;

  select execution_status, status into v_prev, v_status
  from public.tp_tasks where id = p_task_id for update;

  if v_prev is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if v_status <> 'scheduled' then
    raise exception 'Only scheduled tasks can be completed' using errcode = '22023';
  end if;
  if v_prev <> 'pending' then
    raise exception 'Task is already %', v_prev using errcode = '22023';
  end if;

  perform set_config('tp.execution_rpc', 'on', true);
  update public.tp_tasks
  set execution_status = 'completed',
      completed = true,
      completed_at = now(),
      completed_by = auth.uid()
  where id = p_task_id;
  perform set_config('tp.execution_rpc', '', true);

  return public.tp_log_task_event(p_task_id, 'completed', v_prev, 'completed', p_comment);
end $$;

-- PM закрывает задачу: из Completed или из Uncompleted. Task Accepted — результат проверки.
create or replace function public.tp_close_task(p_task_id uuid, p_accepted boolean, p_comment text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_status text;
begin
  if not public.tp_can_approve_task(p_task_id) then
    raise exception 'Not allowed to close this task' using errcode = '42501';
  end if;
  if p_accepted is null then
    raise exception 'Task Accepted must be set' using errcode = '22023';
  end if;

  select execution_status, status into v_prev, v_status
  from public.tp_tasks where id = p_task_id for update;

  if v_prev is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if v_status <> 'scheduled' then
    raise exception 'Only scheduled tasks can be closed' using errcode = '22023';
  end if;
  if v_prev = 'closed' then
    raise exception 'Task is already closed' using errcode = '22023';
  end if;

  perform set_config('tp.execution_rpc', 'on', true);
  update public.tp_tasks
  set execution_status = 'closed',
      task_accepted = p_accepted,
      closed_at = now(),
      closed_by = auth.uid()
  where id = p_task_id;
  perform set_config('tp.execution_rpc', '', true);

  return public.tp_log_task_event(p_task_id, 'closed', v_prev, 'closed', p_comment);
end $$;

-- Комментарий PM к задаче. Статус не меняет; Lead Carpenter видит его в карточке задачи.
create or replace function public.tp_add_review_comment(p_task_id uuid, p_comment text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.tp_can_approve_task(p_task_id) then
    raise exception 'Not allowed to comment on this task' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_comment, '')), '') is null then
    raise exception 'Comment cannot be empty' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tp_tasks where id = p_task_id) then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  return public.tp_log_task_event(p_task_id, 'comment', null, null, p_comment);
end $$;

-- Фото закрытой задачи менять нельзя (было: approved, 0031).
create or replace function public.tp_remove_task_photo(p_photo_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task uuid;
  v_path text;
  v_status text;
begin
  select task_id, path into v_task, v_path from public.tp_task_photos where id = p_photo_id;
  if v_task is null then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if not public.tp_can_act_on_task(v_task) then
    raise exception 'Not allowed to remove photos from this task' using errcode = '42501';
  end if;
  select execution_status into v_status from public.tp_tasks where id = v_task;
  if v_status = 'closed' then
    raise exception 'The task is closed, its photos cannot be changed' using errcode = '22023';
  end if;

  delete from public.tp_task_photos where id = p_photo_id;
  perform public.tp_log_task_event(v_task, 'photo_removed', null, null, null);
  return v_path;
end $$;

-- Подтверждение и возврат на доработку заменены закрытием (BAS-1432 влита в BAS-1431).
drop function if exists public.tp_approve_task(uuid, text);
drop function if exists public.tp_rework_task(uuid, text);

do $$
declare fn text;
begin
  foreach fn in array array[
    'tp_complete_task(uuid, text)',
    'tp_close_task(uuid, boolean, text)',
    'tp_add_review_comment(uuid, text)',
    'tp_remove_task_photo(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

commit;
