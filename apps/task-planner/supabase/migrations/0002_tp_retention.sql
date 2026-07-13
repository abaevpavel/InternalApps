-- ============================================================================
-- Task Planner — ретеншн лог-таблиц (30 дней).
-- Решение 2026-07-13: логи не раздуваем, храним максимум месяц.
-- Применяется на HR DASHBOARD ПОСЛЕ 0001_tp_schema.sql.
--
-- ⚠️ Требует pg_cron (в Supabase: Dashboard → Database → Extensions → включить pg_cron,
--    либо create extension ниже). Локально (ванильный PG без pg_cron) не проверяется.
--    Джобы крутятся на стороне БД — фронт/ретеншн-код не нужен.
-- ============================================================================

create extension if not exists pg_cron;

-- Пере-создание джоб идемпотентно: снимаем старую по имени, ставим заново.
do $$
begin
  perform cron.unschedule('tp_sync_logs_retention');
exception when others then null; end $$;

do $$
begin
  perform cron.unschedule('tp_ai_teams_schedule_retention');
exception when others then null; end $$;

-- sync_logs: ежедневно в 03:00 UTC удаляем записи старше 30 дней.
select cron.schedule(
  'tp_sync_logs_retention',
  '0 3 * * *',
  $$delete from public.tp_sync_logs where created_at < now() - interval '30 days'$$
);

-- AI_teams_schedule (лог запусков планировщика): та же политика 30 дней, 03:10 UTC.
select cron.schedule(
  'tp_ai_teams_schedule_retention',
  '10 3 * * *',
  $$delete from public.tp_ai_teams_schedule where created_at < now() - interval '30 days'$$
);

-- Проверка расписания: select * from cron.job where jobname like 'tp\_%';
