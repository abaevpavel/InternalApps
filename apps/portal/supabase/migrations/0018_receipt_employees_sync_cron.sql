-- BAS-1472: раз в сутки синк сотрудников Receipts Matcher из Airtable.
--
-- pg_cron → pg_net → edge `sync-receipt-employees`. Функция тянет «All employees» из Airtable и
-- обновляет public.receipt_matcher_employees по airtable_record_id (карты не трогает).
--
-- Секрет вызова НЕ лежит в этом файле: он в Supabase Vault под именем `receipt_sync_secret`
-- и тем же значением в секретах edge-функций как RECEIPT_SYNC_SECRET. Завести до этого скрипта
-- (одно значение в оба места):
--   select vault.create_secret('<секрет>', 'receipt_sync_secret');
--
-- Время: 14:00 UTC = 10:00 летом (EDT) / 09:00 зимой (EST) по America/New_York. Синку сотрудников
-- час не важен, поэтому без пересчёта на летнее время (в отличие от HR Sync, 0015).
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'receipt-employees-sync') then
    perform cron.unschedule('receipt-employees-sync');
  end if;
end $$;

select cron.schedule(
  'receipt-employees-sync',
  '0 14 * * *',
  $cmd$
  select net.http_post(
    url     := 'https://pilxwhtkhysanpukaliu.supabase.co/functions/v1/sync-receipt-employees',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'receipt_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cmd$
);
