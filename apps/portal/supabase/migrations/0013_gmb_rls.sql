-- BAS-1353: права на схему `gmb` (настройки GMB-агента).
--
-- ПОРЯДОК: применять ПОСЛЕ того, как в проект перенесены таблицы схемы `gmb`
-- (DDL от Никиты, pg_dump -s -n gmb с проекта Forge). Сама схема здесь не создаётся —
-- только права и политики, переписанные под портальную модель доступа.
--
-- Политики Forge переносить НЕ надо: они завязаны на `auth.jwt() -> app_metadata -> company_id`,
-- такой модели в портале нет. Здесь доступ = апка выдана ролью, ровно как у Production Checklist.
--
-- Ещё один шаг руками: Settings → API → Exposed schemas → добавить `gmb`,
-- иначе PostgREST схему не отдаст и supabase-js её не увидит.

do $$
begin
  if to_regclass('gmb."Setting"') is null then
    raise exception 'Схемы gmb ещё нет. Сначала прогоните DDL схемы, потом этот файл.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Доступ к самой схеме
-- ─────────────────────────────────────────────────────────────────────────────
grant usage on schema gmb to authenticated;

grant select                         on gmb."SettingKey"  to authenticated;
grant select                         on gmb."Region"      to authenticated;
grant select                         on gmb."AgentStatus" to authenticated;
grant select, insert, update, delete on gmb."Setting"     to authenticated;

alter table gmb."Setting"     enable row level security;
alter table gmb."SettingKey"  enable row level security;
alter table gmb."AgentStatus" enable row level security;
alter table gmb."Region"      enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Setting — значения настроек
-- ─────────────────────────────────────────────────────────────────────────────
-- Читает любой залогиненный: экран настроек и так за роут-гейтом, а сами тексты
-- промптов секретом не являются. Правит — тот, кому выдана апка «GMB Agent».
-- Исключение — agent_paused: это стоп-кран всех трёх workflow, он остаётся за админом
-- («developer only» из спеки). Проверка идёт по КЛЮЧУ строки, а не по экрану,
-- поэтому обойти её через прямой запрос к API нельзя.

drop policy if exists gmb_setting_select on gmb."Setting";
create policy gmb_setting_select on gmb."Setting"
  for select to authenticated using (true);

drop policy if exists gmb_setting_admin on gmb."Setting";
create policy gmb_setting_admin on gmb."Setting"
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

drop policy if exists gmb_setting_staff_write on gmb."Setting";
create policy gmb_setting_staff_write on gmb."Setting"
  for all to authenticated
  using (
    public.user_has_application_access(auth.uid(), '/gmb-agent')
    and key <> 'agent_paused'
  )
  with check (
    public.user_has_application_access(auth.uid(), '/gmb-agent')
    and key <> 'agent_paused'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- SettingKey и Region — справочники, форма строится по ним
-- ─────────────────────────────────────────────────────────────────────────────
-- Только чтение: каталог 20 ключей и словарь регионов ведёт агент, экран их не меняет.
-- Политик на запись нет вовсе — значит писать может лишь service_role и владелец.

drop policy if exists gmb_setting_key_select on gmb."SettingKey";
create policy gmb_setting_key_select on gmb."SettingKey"
  for select to authenticated using (true);

drop policy if exists gmb_region_select on gmb."Region";
create policy gmb_region_select on gmb."Region"
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- AgentStatus — пишет агент, экран только показывает
-- ─────────────────────────────────────────────────────────────────────────────
-- Отсюда берутся «applied» вместо «saved» и текст последней неудачной проверки.
-- Роль gmb_agent заводится отдельно (см. ниже) — политик для authenticated на запись нет.

drop policy if exists gmb_agent_status_select on gmb."AgentStatus";
create policy gmb_agent_status_select on gmb."AgentStatus"
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Роль агента
-- ─────────────────────────────────────────────────────────────────────────────
-- Агент подключается своей ролью, а не service_role: так он читает настройки и пишет
-- свой статус, но не видит profiles, applications и задачи планировщика. RLS для него
-- не включаем (bypassrls не даём) — ограничение задаётся грантами.
--
-- Пароль задать отдельно, в этот файл его не кладём:
--   alter role gmb_agent with password '…';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gmb_agent') then
    create role gmb_agent login noinherit;
  end if;
end $$;

grant usage on schema gmb to gmb_agent;
grant select on gmb."Setting", gmb."SettingKey", gmb."Region" to gmb_agent;
grant select, insert, update on gmb."AgentStatus" to gmb_agent;

drop policy if exists gmb_agent_status_write on gmb."AgentStatus";
create policy gmb_agent_status_write on gmb."AgentStatus"
  for all to gmb_agent using (true) with check (true);

drop policy if exists gmb_agent_read_settings on gmb."Setting";
create policy gmb_agent_read_settings on gmb."Setting"
  for select to gmb_agent using (true);

drop policy if exists gmb_agent_read_keys on gmb."SettingKey";
create policy gmb_agent_read_keys on gmb."SettingKey"
  for select to gmb_agent using (true);

drop policy if exists gmb_agent_read_regions on gmb."Region";
create policy gmb_agent_read_regions on gmb."Region"
  for select to gmb_agent using (true);
