-- BAS-1556 / BAS-1503: карточка «Dev Apps» на My Applications — инструменты разработчика
-- (каталог писем Make, payload'ы вебхуков). Видна только ролям Developer и Admin, чтобы не
-- мешать остальным.
--
-- Роль Developer заведена руками (Portal Settings → Roles). Та же схема, что 0011/0017: живая
-- applications без code/sort_order, заполняем только существующие колонки, строку опознаём
-- по url. Идемпотентно.
--
-- Применять вручную: Supabase → SQL Editor.

do $$
declare
  app_id uuid;
  cols   text := 'name, url';
  vals   text := $q$'Dev Apps', '/dev-apps'$q$;
begin
  select id into app_id from public.applications where url = '/dev-apps' limit 1;

  if app_id is null then
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'code') then
      cols := cols || ', code';
      vals := vals || $q$, 'dev-apps'$q$;
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'sort_order') then
      cols := cols || ', sort_order';
      vals := vals || ', 900';
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'description') then
      cols := cols || ', description';
      vals := vals || $q$, 'Developer tools: every email the Make sales scenarios send, and the webhook payloads they receive.'$q$;
    end if;

    execute format('insert into public.applications (%s) values (%s) returning id', cols, vals) into app_id;
  end if;

  insert into public.role_applications (role_id, application_id)
  select r.id, app_id from public.roles r where r.name in ('Admin', 'Developer')
  on conflict do nothing;
end $$;
