-- Task Planner: автосинк с Airtable при входе в приложение + время последнего синка.
--
-- Синк проектов, бригад и навыков запускает браузер того, кто открыл Task Planner (edge-
-- функции sync-airtable-*). Чтобы каждый вход не дёргал Airtable и двое не синкали разом:
--   • tp_claim_auto_sync()        — атомарно решает, нужен ли синк: последний успешный
--                                   был давно (по умолчанию 10 минут) и сейчас никто не
--                                   синкает. Если нужен — заводит строку tp_sync_logs
--                                   (sync_type = 'auto', in_progress) и отдаёт её id;
--   • tp_finish_auto_sync(id, …)  — закрывает строку: completed или failed с текстом ошибки;
--   • tp_sync_status()            — время последнего успешного синка (автосинк или кнопки
--                                   в Directories), идёт ли синк сейчас, последняя ошибка.
-- Зависший синк (вкладку закрыли посреди) через 10 минут считается брошенным.
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

create or replace function public.tp_claim_auto_sync(p_min_interval interval default interval '10 minutes')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- Один решающий за раз: параллельные входы ждут здесь и видят строку первого.
  perform pg_advisory_xact_lock(hashtext('tp_auto_sync'));

  -- Брошенные (вкладку закрыли посреди синка) — закрыть, чтобы не блокировали.
  update public.tp_sync_logs
  set status = 'failed', completed_at = now(), error_message = 'Abandoned: no result within 10 minutes'
  where sync_type = 'auto' and status = 'in_progress' and started_at < now() - interval '10 minutes';

  if exists (
    select 1 from public.tp_sync_logs
    where (status = 'in_progress' and sync_type = 'auto')
       or (status = 'completed' and completed_at > now() - p_min_interval)
  ) then
    return null;
  end if;

  insert into public.tp_sync_logs (sync_type, status) values ('auto', 'in_progress') returning id into v_id;
  return v_id;
end $$;

create or replace function public.tp_finish_auto_sync(p_id uuid, p_ok boolean, p_error text default null, p_records integer default 0)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.tp_sync_logs
  set status = case when p_ok then 'completed' else 'failed' end,
      completed_at = now(),
      error_message = case when p_ok then null else left(p_error, 1000) end,
      records_synced = coalesce(p_records, 0)
  where id = p_id and sync_type = 'auto' and status = 'in_progress';
end $$;

create or replace function public.tp_sync_status()
returns table (last_synced_at timestamptz, in_progress boolean, last_error text, last_error_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select max(completed_at) from public.tp_sync_logs where status = 'completed'),
    exists (select 1 from public.tp_sync_logs
            where sync_type = 'auto' and status = 'in_progress' and started_at > now() - interval '10 minutes'),
    f.error_message,
    f.completed_at
  from (select 1) one
  left join lateral (
    select l.error_message, l.completed_at from public.tp_sync_logs l
    where l.status = 'failed'
      and l.completed_at > coalesce((select max(completed_at) from public.tp_sync_logs where status = 'completed'), '-infinity')
    order by l.completed_at desc limit 1
  ) f on true
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'tp_claim_auto_sync(interval)',
    'tp_finish_auto_sync(uuid, boolean, text, integer)',
    'tp_sync_status()'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

commit;
