-- Укрепление RLS: три политики, открывающие данные шире, чем нужно.
-- Инвентаризация живой БД 2026-09-09: RLS включён на всех 37 таблицах public,
-- таблиц без политик нет — проблемы только в самих условиях.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.
--
-- ⚠️ Живая схема разошлась с миграциями репозитория: функции public.user_has_admin_role(uuid)
-- и public.user_has_application_access(uuid, text) существуют ТОЛЬКО на проде, их DDL здесь нет.
-- Вторая уже используется в Production Checklist — этот файл распространяет тот же приём.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. tp_task_batch_snapshots — было `ALL to public using (true)`
-- ─────────────────────────────────────────────────────────────────────────────
-- Роль public в Postgres включает anon, а anon-ключ лежит в JS-бандле портала. То есть
-- снапшоты батчей задач читались и писались кем угодно, кто открыл сайт (тот же класс, что SEC-9).
-- Фронт с таблицей не работает вовсе (ни одного обращения в src/), пишет её планировщик
-- под service_role, которому RLS не помеха. Закрываем до админа.
--
-- ⚠️ Если после этого планировщик перестанет складывать снапшоты — значит n8n ходит
-- в Supabase не под service_role, а под anon-ключом; чинить надо там, а не возвратом политики.

drop policy if exists "Allow all operations on task_batch_snapshots" on public.tp_task_batch_snapshots;

drop policy if exists tp_batch_snapshots_admin on public.tp_task_batch_snapshots;
create policy tp_batch_snapshots_admin on public.tp_task_batch_snapshots
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. email_templates (Sales) — было `auth.role() = 'authenticated'` на все 4 команды
-- ─────────────────────────────────────────────────────────────────────────────
-- Любой сотрудник портала мог править и УДАЛЯТЬ шаблоны писем клиентам, даже без выданной
-- апки. Переводим на ту же модель, что у Production Checklist: доступ = апка выдана ролью.

do $$
begin
  if not exists (select 1 from public.applications where url = '/sales-email-sender') then
    raise exception
      'Нет строки applications с url = ''/sales-email-sender''. Без неё политика закроет Sales для всех, кроме админа. Заведите приложение и повторите.';
  end if;
end $$;

drop policy if exists "Authenticated users can view templates"   on public.email_templates;
drop policy if exists "Authenticated users can create templates" on public.email_templates;
drop policy if exists "Authenticated users can update templates" on public.email_templates;
drop policy if exists "Authenticated users can delete templates" on public.email_templates;

drop policy if exists email_templates_admin on public.email_templates;
create policy email_templates_admin on public.email_templates
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

drop policy if exists email_templates_app_users on public.email_templates;
create policy email_templates_app_users on public.email_templates
  for all to authenticated
  using (public.user_has_application_access(auth.uid(), '/sales-email-sender'))
  with check (public.user_has_application_access(auth.uid(), '/sales-email-sender'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. profiles — было `INSERT to public with check (true)`
-- ─────────────────────────────────────────────────────────────────────────────
-- Строку в whitelist мог вставить кто угодно, включая anon: достаточно добавить себе
-- профиль с нужным email — и вход открыт. Политика ставилась «для системы», но система
-- в ней не нуждается: профили создают accept_invitation_for() и handle_new_user_invitation(),
-- обе security definer и RLS обходят. Фронт в profiles только читает и обновляет
-- (services/data.ts: select и update, ни одного insert) — INSERT нужен только админу.

drop policy if exists "System can insert profiles" on public.profiles;

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated
  with check (public.user_has_admin_role(auth.uid()));
