-- SEC-7: закрыть анонимное чтение таблиц Task Planner (tp_*).
--
-- Обнаружено 2026-08-04 прямой проверкой боевой БД: с одним лишь anon-ключом (он лежит
-- в бандле фронта, публичен по определению) без логина читались:
--   tp_projects (128 строк — адреса объектов), tp_teams (9 — ФИО, рабочие email,
--   ДОМАШНИЕ адреса и координаты бригадиров), tp_skills (92), tp_task_types (8),
--   tp_team_availability (2), tp_ai_teams_schedule (1), tp_sync_logs (5).
-- В аудите SEC-3 это не всплыло: там проверялись только портальные таблицы, tp_* не входили.
-- tp_tasks / tp_profiles / tp_user_roles / tp_app_settings / tp_travel_cache /
-- tp_task_batch_snapshots анониму уже были закрыты — их не трогаем.
--
-- Почему безопасно для бэкенда: все синк-функции (sync-airtable-*, sync-team-accounts,
-- auto-sync-airtable, set-team-password) ходят с SERVICE_ROLE, n8n — с credential
-- типа supabaseApi (service role secret). service_role обходит RLS целиком.
-- Единственный потребитель через anon-ключ — фронт портала, всегда под user-JWT
-- (роль authenticated), поэтому политики переводим anon → authenticated.
--
-- ⚠️ Применяется вручную через SQL Editor боевого проекта pilxwhtkhysanpukaliu
-- (repo-миграции 0001_tp_schema.sql расходятся с боевой схемой — политик там нет вовсе,
-- живые политики завёл Lovable). Идемпотентно: старые политики сносятся по факту
-- существования, новые создаются с нашими именами.

begin;

-- 0) Основа ролевой модели Task Planner: «моя бригада» = строка tp_teams, чей email
--    совпал с email залогиненного юзера. Роль внутри апки НЕ хранится отдельно
--    (правило 3 платформы: контур допуска — портальный), а выводится: админ портала →
--    TP Admin, совпадение по email → Team Lead своей бригады.
--    security definer: читает auth.users и обходит RLS tp_teams, иначе политика,
--    которая вызывает эту функцию, ушла бы в рекурсию.
create or replace function public.tp_my_team_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from public.tp_teams t
  where t.email is not null
    and lower(t.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
  limit 1
$$;

revoke all on function public.tp_my_team_id() from public;
grant execute on function public.tp_my_team_id() to authenticated;

-- 1) Снести ВСЕ существующие политики на течущих таблицах и включить RLS.
--    Дропаем по каталогу, а не по имени: имена политик на боевой БД неизвестны
--    (заводились не нами). Ниже сразу создаём полный набор взамен.
do $$
declare
  t text;
  p record;
  leaky_tables text[] := array[
    'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types',
    'tp_team_availability', 'tp_ai_teams_schedule', 'tp_sync_logs'
  ];
begin
  foreach t in array leaky_tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skip %: table not found', t;
      continue;
    end if;

    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 2) Новые политики: читать может любой залогиненный, писать — только админ портала.
--    Разделение чтение/запись, а не общий ALL: справочники наполняет синк под
--    service_role, руками из UI их правит только админ (Directories → Task Types).
do $$
declare
  t text;
  read_tables text[] := array[
    'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types',
    'tp_team_availability', 'tp_ai_teams_schedule', 'tp_sync_logs'
  ];
begin
  foreach t in array read_tables loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format($f$
      create policy tp_read_authenticated on public.%I
        for select to authenticated using (true)
    $f$, t);

    execute format($f$
      create policy tp_write_admin on public.%I
        for all to authenticated
        using (public.user_has_admin_role(auth.uid()))
        with check (public.user_has_admin_role(auth.uid()))
    $f$, t);
  end loop;
end $$;

-- 3) tp_team_availability — исключение: бригадир правит доступность СВОЕЙ бригады.
--    Опирается на tp_my_team_id() из п.0. Политика поверх админской из п.2:
--    политики одной команды складываются по OR, поэтому админ сохраняет полный доступ.
do $$
begin
  if to_regclass('public.tp_team_availability') is not null then
    execute $f$
      create policy tp_availability_own_team on public.tp_team_availability
        for all to authenticated
        using (team_id = public.tp_my_team_id())
        with check (team_id = public.tp_my_team_id())
    $f$;
  end if;
end $$;

commit;
