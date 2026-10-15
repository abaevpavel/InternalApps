-- Task Planner: смена PM задачи с карточки и история изменений модуля.
--
-- 1) tp_set_task_pm(task, email) — сменить PM задачи. Меняет и саму задачу, и её копии
--    в Proposed / Scheduled (request_task_id = задача): копии берут pm_email из оригинала
--    один раз при материализации, без этого «свои задачи» PM остались бы у прежнего.
--    PM выбирается только из справочника людей (tp_people). Может PM модуля (edit_task).
--
-- 2) История: таблицы модуля подключаются к общей истории портала portal_audit_log
--    (миграция 0019) с app_url '/task-planner'. Пишет триггер, поэтому в историю попадает
--    любое изменение — с экрана, из n8n, от синка — с автором и старым/новым значением.
--    Журнал исполнения tp_task_events — уже сам лог, его не дублируем; служебные таблицы
--    (кэш маршрутов, логи синка, снимки батчей) — тоже.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

-- ============================================================
-- 1) Смена PM задачи
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

  select e.full_name into v_name
  from public.receipt_matcher_employees e
  where e.active and lower(e.email) = v_email
  limit 1;
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

revoke all on function public.tp_set_task_pm(uuid, text) from public;
grant execute on function public.tp_set_task_pm(uuid, text) to authenticated;

-- ============================================================
-- 2) История изменений модуля
-- ============================================================
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('tp_tasks',             'id',  array['updated_at']),
      ('tp_task_photos',       'id',  array[]::text[]),
      ('tp_teams',             'id',  array['updated_at', 'account_synced_at']),
      ('tp_team_availability', 'id',  array['updated_at']),
      ('tp_skills',            'id',  array['updated_at']),
      ('tp_task_types',        'id',  array['updated_at']),
      ('tp_projects',          'id',  array['updated_at']),
      ('tp_app_settings',      'key', array['updated_at', 'updated_by'])
    ) as v(tbl, keycol, ignore_cols)
  loop
    if to_regclass('public.' || t.tbl) is null then
      raise notice 'skip %: table not found', t.tbl;
      continue;
    end if;
    execute format('drop trigger if exists portal_audit on public.%I', t.tbl);
    execute format(
      'create trigger portal_audit after insert or update or delete on public.%I
         for each row execute function public.portal_audit_row(%L, %L%s)',
      t.tbl, '/task-planner', t.keycol,
      (select coalesce(string_agg(format(', %L', c), ''), '') from unnest(t.ignore_cols) c)
    );
  end loop;
end $$;

commit;
