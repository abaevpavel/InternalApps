-- SEC-10: бакет `buildertrend-schedule-photos` разрешал анониму ЛИСТИНГ объектов.
--
-- Миграция 0004 завела политику `bts_photos_read ... for select to anon, authenticated`.
-- Из-за роли `anon` содержимое бакета перечисляется публичным anon-ключом (он лежит в
-- JS-бандле портала), т.е. любой, кто открывал портал, может получить список всех
-- загруженных расписаний и скачать их. Проверено curl'ом: POST /storage/v1/object/list/
-- buildertrend-schedule-photos с anon-ключом отдавал содержимое, у остальных трёх
-- бакетов такой политики нет и они отвечают пусто.
--
-- Публичные ссылки, которые апка шлёт в Make, при этом продолжают работать: они идут
-- через /storage/v1/object/public/... — этот путь смотрит на флаг `public` у бакета,
-- а не на RLS-политику. Меняется ровно одно: пропадает возможность ПЕРЕЧИСЛИТЬ файлы
-- и читать их через authenticated-API без логина.
--
-- ⚠️ Применяется на боевом Supabase (HR DASHBOARD) вручную через SQL Editor. Идемпотентно.
--
-- Остаточный риск (осознанный, SEC-5): бакет остаётся `public`, поэтому файл по прямой
-- ссылке открывается без логина. Ссылка не угадывается (UUID в пути) и нужна Make,
-- чтобы приложить файл к письму. Полный фикс — private-бакет + signed URLs.

begin;

drop policy if exists bts_photos_read on storage.objects;

create policy bts_photos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'buildertrend-schedule-photos');

commit;

-- Проверка после применения (должно вернуться пусто / ошибку доступа, а не список файлов):
--   curl -X POST "$SUPABASE_URL/storage/v1/object/list/buildertrend-schedule-photos" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--        -H "Content-Type: application/json" -d '{"prefix":"","limit":5}'
