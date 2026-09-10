-- 06-HR-Sync Airtable Contacts: расписание автосинка, редактируемое из портала.
--
-- Расписание живёт в pg_cron. Напрямую в `cron.job` из браузера не ходим: там произвольный
-- SQL, выполняемый суперпользователем, — открыть эту таблицу наружу означало бы дать любому
-- с anon-ключом ставить себе задания. Доступ только через функции ниже, и только к четырём
-- известным заданиям.
--
-- ГЛАВНОЕ — ВРЕМЯ. Сервер и pg_cron работают в UTC, а люди в офисе живут по America/New_York,
-- где дважды в год смещение меняется (EST −5 / EDT −4). Поэтому:
--   • человек вводит и видит СВОЁ время (ET);
--   • в `cron.job` кладётся пересчитанное UTC;
--   • раз в сутки задание `hr-sync-reschedule` пересчитывает всё заново, поэтому переход
--     на летнее/зимнее время подхватывается сам.
-- Именно этого не хватало раньше: `0 16 * * *` ставили под 11:00 EST, и с приходом лета
-- синк молча начал отрабатывать в 12:00 ET — имена заданий (11am/5pm) до сих пор врут.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.hr_sync_schedule (
  jobname      text primary key,
  -- Время, которое ввёл человек, в своей зоне. Источник правды — оно, а не cron-выражение.
  local_hour   int  not null check (local_hour   between 0 and 23),
  local_minute int  not null check (local_minute between 0 and 59),
  tz           text not null default 'America/New_York',
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

alter table public.hr_sync_schedule enable row level security;
-- Пишут только функции ниже (security definer); клиенту таблица нужна лишь на чтение.
drop policy if exists hr_sync_schedule_read on public.hr_sync_schedule;
create policy hr_sync_schedule_read on public.hr_sync_schedule
  for select to authenticated using (true);
grant select on public.hr_sync_schedule to authenticated;

-- Белый список: трогаем только эти задания, не ретеншены и не receipt-import.
create or replace function public.hr_sync_job_allowed(p_jobname text)
returns boolean language sql immutable as $$
  select p_jobname in ('sync-employees-11am', 'sync-employees-5pm',
                       'sync-vendors-11am',   'sync-vendors-5pm');
$$;

create or replace function public.hr_sync_can_manage()
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_has_admin_role(auth.uid())
      or public.user_has_application_access(auth.uid(), '/hr-sync-airtable');
$$;

-- Начальное заполнение: берём то, что уже стоит в cron (UTC), и переводим в ET.
insert into public.hr_sync_schedule (jobname, local_hour, local_minute)
select j.jobname::text,
       extract(hour   from ((current_date + make_time(split_part(j.schedule,' ',2)::int,
                                                      split_part(j.schedule,' ',1)::int, 0))
                            at time zone 'UTC' at time zone 'America/New_York'))::int,
       extract(minute from ((current_date + make_time(split_part(j.schedule,' ',2)::int,
                                                      split_part(j.schedule,' ',1)::int, 0))
                            at time zone 'UTC' at time zone 'America/New_York'))::int
from cron.job j
where public.hr_sync_job_allowed(j.jobname::text)
on conflict (jobname) do nothing;

/**
 * Пересчитать cron-выражения из локального времени. Вызывается при сохранении и раз в сутки
 * заданием `hr-sync-reschedule` — так переход на летнее время подхватывается максимум за сутки.
 */
create or replace function public.hr_sync_apply_schedule()
returns void
language plpgsql security definer set search_path = public, cron as $$
declare
  r record;
  v_utc timestamp;
  v_command text;
begin
  for r in select * from public.hr_sync_schedule loop
    select j.command into v_command from cron.job j where j.jobname = r.jobname;
    continue when v_command is null;

    -- Локальное время сегодня → UTC, с учётом действующего смещения (EST/EDT).
    v_utc := (current_date + make_time(r.local_hour, r.local_minute, 0))
             at time zone r.tz at time zone 'UTC';

    perform cron.schedule(
      r.jobname,
      format('%s %s * * *', extract(minute from v_utc)::int, extract(hour from v_utc)::int),
      v_command
    );
  end loop;
end;
$$;

create or replace function public.hr_sync_get_schedule()
returns table (jobname text, local_hour int, local_minute int, tz text, cron_utc text, active boolean)
language plpgsql stable security definer set search_path = public, cron as $$
begin
  if not public.hr_sync_can_manage() then
    raise exception 'Not allowed';
  end if;

  return query
  select s.jobname, s.local_hour, s.local_minute, s.tz, j.schedule::text, j.active
  from public.hr_sync_schedule s
  join cron.job j on j.jobname = s.jobname
  order by s.jobname;
end;
$$;

create or replace function public.hr_sync_set_schedule(p_jobname text, p_hour int, p_minute int)
returns void
language plpgsql security definer set search_path = public, cron as $$
begin
  if not public.hr_sync_can_manage() then
    raise exception 'Not allowed';
  end if;
  if not public.hr_sync_job_allowed(p_jobname) then
    raise exception 'Unknown job: %', p_jobname;
  end if;
  if p_hour not between 0 and 23 or p_minute not between 0 and 59 then
    raise exception 'Invalid time: %:%', p_hour, p_minute;
  end if;

  insert into public.hr_sync_schedule (jobname, local_hour, local_minute, updated_by)
  values (p_jobname, p_hour, p_minute, auth.uid())
  on conflict (jobname) do update
    set local_hour = excluded.local_hour,
        local_minute = excluded.local_minute,
        updated_at = now(),
        updated_by = excluded.updated_by;

  perform public.hr_sync_apply_schedule();
end;
$$;

-- Ежесуточный пересчёт: ловит смену EST/EDT без участия человека.
select cron.schedule('hr-sync-reschedule', '5 4 * * *', 'select public.hr_sync_apply_schedule()');

-- Привести cron в соответствие с таблицей прямо сейчас.
select public.hr_sync_apply_schedule();

revoke execute on function public.hr_sync_get_schedule()               from public, anon;
revoke execute on function public.hr_sync_set_schedule(text, int, int) from public, anon;
revoke execute on function public.hr_sync_apply_schedule()             from public, anon;
grant  execute on function public.hr_sync_get_schedule()               to authenticated;
grant  execute on function public.hr_sync_set_schedule(text, int, int) to authenticated;
