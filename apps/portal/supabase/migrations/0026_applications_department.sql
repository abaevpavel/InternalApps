-- BAS-1681: у каждой апки — департамент (выбирается из списка) и имя (пишется вручную).
--
-- Департаменты — как папки компании: 01-MARKETING … 09-FORGE. На главной (My Applications)
-- карточки группируются по департаменту по возрастанию, без департамента — последним блоком.
-- Имя апки (`applications.name`) админ меняет в App Settings → General; права на запись
-- у админа уже есть (политика applications_admin_write, 0001).
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

alter table public.applications
  add column if not exists department text;

alter table public.applications
  drop constraint if exists applications_department_check;
alter table public.applications
  add constraint applications_department_check check (
    department is null or department in (
      '01-MARKETING', '02-SALES', '03-PRODUCTION', '04-OPERATIONS', '05-EXECUTIVE',
      '06-HR', '07-FINANCES', '08-IT', '09-FORGE'
    )
  );

-- Начальные значения — там, где департамент уже был в названии апки. Остальным выберет
-- админ. Существующий выбор не перетираем.
update public.applications set department = '02-SALES'
  where url = '/sales-email-sender' and department is null;
update public.applications set department = '03-PRODUCTION'
  where url in ('/production-checklist', '/buildertrend-schedule') and department is null;
update public.applications set department = '06-HR'
  where url in ('/checklists', '/gmail-auto-sender', '/hr-sync-airtable') and department is null;
