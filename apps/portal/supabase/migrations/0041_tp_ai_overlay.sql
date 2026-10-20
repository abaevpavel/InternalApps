-- Task Planner: ответ AI ложится на ту же задачу, а не создаёт копию (TP-1.1), и перенос задачи
-- на другой день (BAS-1437).
--
--   • Ответ AI — не задача, а предложение по расписанию. Из него на строку задачи переносятся
--     только поля расписания: бригада, порядок, начало и конец, время в пути. Название, описание,
--     адрес, приоритет, скиллы, PM, якорь, окно времени и длительность AI не меняет (решение Vlad
--     20.10.2026: «AI не может планировать длительность»).
--   • Задача переходит requested → proposed одной строкой. Всё, что с ней не так (AI не разместил,
--     вернул дважды, сдвинул якорь, поменял длительность, задачу правили после отправки…), остаётся
--     пометкой в ai_warnings — в Proposed это оранжевый треугольник с подсказкой.
--   • Всё применяется одной функцией = одной транзакцией: задачи не могут разойтись наполовину.
--   • Журнал для разработчика tp_ai_run_log: что отправили, что пришло, что применили («до → после»),
--     какие пометки поставлены. Читает только роль Developer.
--   • tp_move_task — перенос задачи на другую дату: та же строка, статус requested, поля расписания
--     от AI снимаются, бригада и окно времени возвращаются к заявленным.
--   • Старые копии (request_task_id) не трогаем — удалим отдельно (решение Vlad 20.10.2026).
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

-- ============================================================
-- 1) Колонки задачи
-- ============================================================
alter table public.tp_tasks add column if not exists ai_warnings jsonb;
alter table public.tp_tasks add column if not exists requested_team_id uuid;

comment on column public.tp_tasks.ai_warnings is
  'Пометки после ответа AI: [{code, message}]. Пусто — вопросов к задаче нет. Снимаются при переносе.';
comment on column public.tp_tasks.requested_team_id is
  'Бригада, заданная в заявке до ответа AI (null — бригаду выбирал AI). Возвращается при переносе в Requested.';

-- ============================================================
-- 2) Журнал прогонов AI (только Developer)
-- ============================================================
create table if not exists public.tp_ai_run_log (
  id          bigserial primary key,
  request_id  text not null,
  batch_date  date,
  task_id     uuid,
  kind        text not null check (kind in ('sent', 'applied', 'ignored')),
  sent        jsonb,
  received    jsonb,
  applied     jsonb,
  warnings    jsonb,
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists tp_ai_run_log_request_idx on public.tp_ai_run_log (request_id, task_id);
create index if not exists tp_ai_run_log_created_idx on public.tp_ai_run_log (created_at desc);

comment on table public.tp_ai_run_log is
  'Журнал Send to AI: по строке на задачу — что отправили (sent), что пришло и что применили (applied) или почему пропустили (ignored). Пишут только функции tp_ai_*; читает Developer.';

alter table public.tp_ai_run_log enable row level security;
revoke all on public.tp_ai_run_log from anon, authenticated;
grant select on public.tp_ai_run_log to authenticated;

drop policy if exists tp_ai_run_log_read on public.tp_ai_run_log;
create policy tp_ai_run_log_read on public.tp_ai_run_log
  for select to authenticated
  using (public.portal_is_developer());

-- ============================================================
-- 3) Отправка в AI: пометить задачи дня и снять снимок
-- ============================================================
create or replace function public.tp_ai_mark_sent(p_request_id text, p_date date, p_task_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.tp_has_module_role('schedule_manager') then
    raise exception 'Not allowed to send tasks to the AI' using errcode = '42501';
  end if;
  if coalesce(btrim(p_request_id), '') = '' or p_date is null then
    raise exception 'Request id and date are required' using errcode = '22023';
  end if;

  -- только задачи Requested выбранного дня: другие даты ждут своего дня
  with marked as (
    update public.tp_tasks t
       set ai_request_id = p_request_id, ai_sent_at = now()
     where t.id = any(p_task_ids)
       and t.status = 'requested'
       and t.scheduled_date = p_date
    returning t.*
  )
  insert into public.tp_ai_run_log (request_id, batch_date, task_id, kind, sent)
  select p_request_id, p_date, m.id, 'sent', to_jsonb(m) from marked m;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.tp_ai_mark_sent(text, date, uuid[]) from public;
grant execute on function public.tp_ai_mark_sent(text, date, uuid[]) to authenticated;

-- ============================================================
-- 4) Ответ AI: наложить поля расписания на те же задачи
-- ============================================================
-- p_items: [{ task_id, team_id|null, stop_number|null, start|null, end|null, travel|null,
--             warnings: [{code, message}], received: {...} }]
-- Применяется только к задачам, которые всё ещё ждут ЭТОТ запрос (status requested,
-- ai_request_id = p_request_id). Остальное — в журнал как ignored.
create or replace function public.tp_ai_apply(p_request_id text, p_date date, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item     jsonb;
  v_task     public.tp_tasks%rowtype;
  v_sent     jsonb;
  v_warn     jsonb;
  v_old_st   jsonb;
  v_anchor   boolean;
  v_anchor_t text;
  v_new_st   jsonb;
  v_team     uuid;
  v_applied  integer := 0;
  -- служебные поля, которые меняются без участия человека: правкой задачи не считаются
  v_skip     text[] := array['updated_at', 'ai_request_id', 'ai_sent_at', 'total_time'];
begin
  if not public.tp_has_module_role('schedule_manager') then
    raise exception 'Not allowed to apply the AI schedule' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Items must be an array' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_task from public.tp_tasks
     where id = (v_item->>'task_id')::uuid
       and status = 'requested'
       and ai_request_id = p_request_id
     for update;

    if not found then
      insert into public.tp_ai_run_log (request_id, batch_date, task_id, kind, received, warnings, note)
      values (p_request_id, p_date, (v_item->>'task_id')::uuid, 'ignored', v_item->'received', v_item->'warnings',
              'Task is not waiting for this request (moved, edited away from Requested or already applied)');
      continue;
    end if;

    v_warn := coalesce(v_item->'warnings', '[]'::jsonb);

    -- задачу правили после отправки: снимок отправки расходится с текущей строкой
    select l.sent into v_sent from public.tp_ai_run_log l
     where l.request_id = p_request_id and l.task_id = v_task.id and l.kind = 'sent'
     order by l.id desc limit 1;
    if v_sent is not null
       and (v_sent - v_skip) is distinct from (to_jsonb(v_task) - v_skip) then
      v_warn := v_warn || jsonb_build_array(jsonb_build_object(
        'code', 'edited_after_send',
        'message', 'The task was changed after it was sent to the AI — the schedule was built on the old version'));
    end if;

    -- якорь и окно времени — из заявки, не от AI
    v_old_st := v_task.scheduled_time;
    v_anchor := coalesce((v_old_st->>'anchor')::boolean, false) or (v_old_st->>'type') = 'exact';
    v_anchor_t := case when v_anchor
                       then coalesce(nullif(v_old_st->>'time', ''), nullif(v_old_st->>'anchor_time', ''), v_old_st->>'start')
                  end;
    v_new_st := jsonb_strip_nulls(jsonb_build_object(
      'start', nullif(v_item->>'start', ''),
      'end', nullif(v_item->>'end', ''),
      'anchor', case when v_anchor then true end,
      'anchor_time', v_anchor_t))
      -- заявленное окно времени храним всегда, даже пустое: по нему перенос возвращает заявку
      || jsonb_build_object('requested', coalesce(v_old_st, 'null'::jsonb));

    -- бригада: от AI; если AI бригаду не дал — остаётся заявленная
    v_team := coalesce(nullif(v_item->>'team_id', '')::uuid, v_task.team_id);

    update public.tp_tasks
       set status = 'proposed',
           requested_team_id = v_task.team_id,
           team_id = v_team,
           stop_number = nullif(v_item->>'stop_number', '')::integer,
           scheduled_time = v_new_st,
           travel_time = nullif(v_item->>'travel', '')::numeric,
           ai_warnings = case when jsonb_array_length(v_warn) > 0 then v_warn end,
           ai_request_id = null,
           ai_sent_at = null
     where id = v_task.id;

    insert into public.tp_ai_run_log (request_id, batch_date, task_id, kind, received, applied, warnings)
    values (p_request_id, p_date, v_task.id, 'applied', v_item->'received',
            jsonb_build_object(
              'before', jsonb_build_object('team_id', v_task.team_id, 'stop_number', v_task.stop_number,
                                           'scheduled_time', v_task.scheduled_time, 'travel_time', v_task.travel_time),
              'after', jsonb_build_object('team_id', v_team, 'stop_number', nullif(v_item->>'stop_number', '')::integer,
                                          'scheduled_time', v_new_st, 'travel_time', nullif(v_item->>'travel', '')::numeric)),
            v_warn);
    v_applied := v_applied + 1;
  end loop;

  return v_applied;
end $$;

revoke all on function public.tp_ai_apply(text, date, jsonb) from public;
grant execute on function public.tp_ai_apply(text, date, jsonb) to authenticated;

-- ============================================================
-- 5) Перенос задачи на другую дату (BAS-1437)
-- ============================================================
create or replace function public.tp_move_task(p_task_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task  public.tp_tasks%rowtype;
  v_sm    boolean := public.tp_has_module_role('schedule_manager');
  v_pm    boolean := public.tp_has_module_role('pm');
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if not (v_sm or v_pm) then
    raise exception 'Not allowed to move tasks' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'Date is required' using errcode = '22023';
  end if;

  select * into v_task from public.tp_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
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
  -- Schedule Manager — любую; PM — только свою (pm_email или автор)
  if not v_sm and not (lower(coalesce(v_task.pm_email, '')) = v_email
                       or coalesce(v_task.created_by, '') = auth.uid()::text) then
    raise exception 'A PM can move only their own tasks' using errcode = '42501';
  end if;

  update public.tp_tasks
     set scheduled_date = p_date,
         status = 'requested',
         team_id = case when v_task.status = 'requested' then v_task.team_id else v_task.requested_team_id end,
         scheduled_time = case when v_task.scheduled_time ? 'requested'
                               then nullif(v_task.scheduled_time->'requested', 'null'::jsonb)
                               else v_task.scheduled_time end,
         stop_number = null,
         travel_time = null,
         requested_team_id = null,
         ai_warnings = null,
         ai_request_id = null,
         ai_sent_at = null
   where id = p_task_id;
end $$;

revoke all on function public.tp_move_task(uuid, date) from public;
grant execute on function public.tp_move_task(uuid, date) to authenticated;

commit;
