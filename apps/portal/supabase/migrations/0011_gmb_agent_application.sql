-- BAS-1353: карточка «GMB Agent» на My Applications.
--
-- Карточки главной берутся из public.applications через role_applications роли юзера —
-- реестр в коде (appRegistry.ts) отвечает только за роут, меню и экран настроек. Пока
-- строки здесь нет, апка доступна лишь по прямой ссылке и лишь админу (admin bypass
-- в AppAccessGuard).
--
-- ⚠️ Живая схема портала разошлась с миграциями репозитория: в БД у applications НЕТ
-- колонок code/sort_order (зато есть description/icon/created_at). Поэтому строку
-- заводим динамически — заполняем только те колонки, которые реально существуют,
-- и опознаём её по url. Скрипт идемпотентен: повторный прогон ничего не дублирует.
--
-- Применять вручную: Supabase → SQL Editor.

do $$
declare
  app_id uuid;
  cols   text := 'name, url';
  vals   text := $q$'GMB Agent', '/gmb-agent'$q$;
begin
  select id into app_id from public.applications where url = '/gmb-agent' limit 1;

  if app_id is null then
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'code') then
      cols := cols || ', code';
      vals := vals || $q$, 'gmb-agent'$q$;
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'sort_order') then
      cols := cols || ', sort_order';
      vals := vals || ', 70';
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'description') then
      cols := cols || ', description';
      vals := vals || $q$, 'Settings for the Google Business Profile agent: reply voice, post topics and schedules.'$q$;
    end if;

    execute format('insert into public.applications (%s) values (%s) returning id', cols, vals) into app_id;
  end if;

  -- Admin видит все апки — GMB не исключение. Остальные роли назначает
  -- Portal Settings → Roles, руками.
  insert into public.role_applications (role_id, application_id)
  select r.id, app_id from public.roles r where r.name = 'Admin'
  on conflict do nothing;
end $$;
