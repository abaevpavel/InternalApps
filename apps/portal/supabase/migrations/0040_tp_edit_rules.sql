-- Task Planner: правила правки задачи по статусу (BAS-1514) и пометка «отправлено в AI».
--
--   • Задачу, которую бригада отметила выполненной (execution_status = completed) или PM закрыл
--     (closed), менять нельзя — ни одно поле. Раньше триггер из 0033 сторожил только статус
--     исполнения и дату закрытой задачи, а политика tp_tasks_update давала PM правку строки целиком.
--     Исключения: функции исполнения (флаг tp.execution_rpc, закрытие из Completed) и service_role.
--   • tp_set_task_pm меняет PM у задачи и её копий в расписании (режим тестов) — теперь только
--     у незакрытых и невыполненных: иначе смена PM в Requested упиралась бы в новую защиту.
--   • ai_request_id / ai_sent_at — задача отправлена в AI и ждёт ответа. Пока пометка свежая,
--     задачи в Requested недоступны у всех пользователей. Ставит и снимает фронт при Send to AI.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

-- ============================================================
-- 1) Пометка «отправлено в AI»
-- ============================================================
alter table public.tp_tasks add column if not exists ai_request_id text;
alter table public.tp_tasks add column if not exists ai_sent_at timestamptz;

comment on column public.tp_tasks.ai_request_id is
  'request_ID запуска планировщика, в который задача отправлена и ответа которого ждёт (BAS-1514). null — не ждёт.';
comment on column public.tp_tasks.ai_sent_at is
  'Когда задача отправлена в AI (BAS-1514). Пометка считается действующей, пока не прошло время ожидания ответа.';

-- ============================================================
-- 2) Защита: выполненная и закрытая задача не правится
-- ============================================================
create or replace function public.tp_tasks_guard_execution()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- служебные колонки, которые меняются без участия человека
  v_skip text[] := array['updated_at', 'ai_request_id', 'ai_sent_at'];
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
  -- BAS-1514: Completed и Closed — правка запрещена.
  if old.execution_status in ('completed', 'closed')
     and coalesce(current_setting('tp.execution_rpc', true), '') <> 'on'
     and (to_jsonb(new) - v_skip) is distinct from (to_jsonb(old) - v_skip) then
    raise exception 'A completed or closed task cannot be edited' using errcode = '22023';
  end if;
  return new;
end $$;

-- ============================================================
-- 3) Смена PM — только у задач, которые ещё можно править
-- ============================================================
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
    and execution_status = 'pending'
    and pm_email is distinct from v_email;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

commit;
