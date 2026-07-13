-- 03-Production — Send Buildertrend Schedule.
-- Апка живёт роутом портала (/buildertrend-schedule): селектор проекта (общая таблица
-- projects, read-only) + drag-and-drop фото → публичный бакет → POST { project_name, photos }
-- на Make-вебхук. Своих таблиц у апки нет — только storage-бакет и карточка в applications.
--
-- ⚠️ Применяется на существующем Lovable-Supabase вручную (SQL Editor). Идемпотентно.
-- Опирается на уже существующую public.user_has_admin_role(uuid) (её дёргает портал).

-- 1) Публичный бакет для фото расписаний (public read по URL, upload — только authenticated).
insert into storage.buckets (id, name, public)
values ('buildertrend-schedule-photos', 'buildertrend-schedule-photos', true)
on conflict (id) do nothing;

-- Загрузка/правка/удаление объектов бакета — любой authenticated (перенос как есть, без owner-only).
drop policy if exists bts_photos_insert on storage.objects;
create policy bts_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'buildertrend-schedule-photos');

drop policy if exists bts_photos_update on storage.objects;
create policy bts_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'buildertrend-schedule-photos')
  with check (bucket_id = 'buildertrend-schedule-photos');

drop policy if exists bts_photos_delete on storage.objects;
create policy bts_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'buildertrend-schedule-photos');

-- Публичное чтение (бакет public — на случай, если проектные политики требуют явного select для anon).
drop policy if exists bts_photos_read on storage.objects;
create policy bts_photos_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'buildertrend-schedule-photos');

-- 2) Карточка приложения в портале.
-- ⚠️ Реальная (Lovable) схema public.applications: id, name, description, url, icon,
-- created_by, created_at, updated_at — БЕЗ code/sort_order (repo-миграция 0001 расходится
-- с боевой БД). Карточка «03-Production-Send Buildertrend Schedule» в бою уже существует и
-- имеет назначения ролей — поэтому тут только проставляем ей внутренний роут (url, начинающийся
-- с '/', MyApplications открывает внутри портала). Идемпотентно, ничего не создаёт.
update public.applications
set url = '/buildertrend-schedule', updated_at = now()
where url like '/buildertrend%';
