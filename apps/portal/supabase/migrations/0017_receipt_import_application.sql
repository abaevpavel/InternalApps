-- BAS-1450: карточка «07 Finances — Receipts Matcher» на My Applications.
--
-- Таблицы receipt_import_*, receipt_matcher_* и edge-функцию `receipt-import` завёл Никита
-- (BAS-1449 и др.); их RLS и сервер пускают по
-- `user_has_application_access(auth.uid(), '/receipt-import')` — поэтому url строго такой.
-- Пока строки нет, всё это открывается только админу.
--
-- Та же схема, что 0011 (GMB): живая applications разошлась с миграциями (нет code/sort_order),
-- поэтому заполняем только существующие колонки и опознаём строку по url. Идемпотентно.
--
-- Доступ: Admin и Bookkeeping (бухгалтер Hélida и владелец; роль заведена руками
-- в Portal Settings → Roles). Если роли с таким именем нет — просто пропускается.
--
-- Применять вручную: Supabase → SQL Editor.

do $$
declare
  app_id uuid;
  cols   text := 'name, url';
  vals   text := $q$'07 Finances — Receipts Matcher', '/receipt-import'$q$;
begin
  select id into app_id from public.applications where url = '/receipt-import' limit 1;

  if app_id is null then
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'code') then
      cols := cols || ', code';
      vals := vals || $q$, 'receipt-import'$q$;
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'sort_order') then
      cols := cols || ', sort_order';
      vals := vals || ', 80';
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'description') then
      cols := cols || ', description';
      vals := vals || $q$, 'Import card and supplier exports into TRANSACTIONS, and keep the receipts automation settings.'$q$;
    end if;

    execute format('insert into public.applications (%s) values (%s) returning id', cols, vals) into app_id;
  end if;

  insert into public.role_applications (role_id, application_id)
  select r.id, app_id from public.roles r where r.name in ('Admin', 'Bookkeeping')
  on conflict do nothing;
end $$;
