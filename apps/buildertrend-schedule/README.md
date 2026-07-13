# buildertrend-schedule

> 03-PRODUCTION-SEND BUILDERTREND SCHEDULE **живёт роутом внутри портала** (`apps/portal`) —
> `/buildertrend-schedule`. Карточка в портале: `applications.url = '/buildertrend-schedule'`.

Код:
- Страница: `apps/portal/src/pages/buildertrend-schedule/SendBuildertrendSchedule.tsx`
- Сервис: `apps/portal/src/services/buildertrend-schedule.ts`
- Edge-функция (список проектов): `apps/portal/supabase/functions/list-schedule-projects/index.ts`
- Миграция (bucket): `apps/portal/supabase/migrations/0004_buildertrend_schedule.sql`

## Что делает
Маленькая форма для продакшена: выбрать проект (поиск), приложить расписание (PDF или фото,
drag-and-drop, несколько) и **Submit**.

1. **Project** — поисковый комбобокс, живой список из Airtable «General Project Info»
   (`appucrtf5MBcFXVza`, поле `Project Name`) через edge-функцию `list-schedule-projects`.
   ⚠️ Именно из Airtable, а НЕ из Supabase `projects`: значение проекта должно точно совпадать с
   формулой поиска сценария Make (`{Project Name} = '{{12.project}}'`). Подпись может нести
   статус-префикс (`DEPOSIT_/PROP_`) — если задан secret `AIRTABLE_STATUS_FIELD`.
2. **Files** — drag-and-drop / browse; принимаем `image/*` и `application/pdf`. Картинки жмём
   в JPEG (`compressToJpeg`, ≤1MB, ≤2000px); PDF заливаем как есть → публичный бакет
   `buildertrend-schedule-photos`.
3. **Submit** — POST на Make-вебхук в формате **JotForm-обёртки** под существующий сценарий
   «SEND SCHEDULE JOTFORM» (formID `241016020135133`).

### Контракт вебхука
Сценарий Make: `CustomWebhook → parseJson(rawRequest) → Airtable-поиск {Project Name} =
'{{12.project}}' → HTTP GET {{12.input119[1]}} → Slack upload + email клиенту с вложением
{{12.input119}}`. Значимая часть нашего POST — строка `rawRequest`, где сценарию нужны **ровно
два поля**: `project` (имя проекта) и `input119` (массив public-URL файлов, Make индексирует с 1).
Верхний уровень (JotForm-поля) сценарием не читается — держим для паритета/отладки.

```jsonc
{
  "formID": "241016020135133",
  "formTitle": "PM-SEND SCHEDULE",
  "rawRequest": "{\"project\":\"Allred-Takoma Park, MD\",\"input119\":[\"https://…/schedule.pdf\"], …}",
  // + payload_from / project_id / sent_at — служебное, сценарием не используется
}
```
Файлы Make скачивает сам по URL и рассылает. Доставку приложение не отслеживает.

> ⚠️ **Имя проекта должно совпадать** с полем `Project Name` в Airtable-базе «General Project
> Info» (`appucrtf5MBcFXVza`) — иначе Airtable-поиск в сценарии не найдёт запись и письмо/Slack
> не уйдут. У нас имя берётся из Supabase `projects.name` (Buildertrend-синк); при расхождении
> форматов (напр. date-префикс) нужно выравнивать источники.

## Env
- `VITE_MAKE_BUILDERTREND_SCHEDULE` — приёмный вебхук (`hook.us1.make.com/2cg9f7py8…`).
  Переопределяется в рантайме через **App Settings → Webhooks** (`schedule_webhook`).

## Ресурсы
- **Storage:** публичный бакет `buildertrend-schedule-photos` (upload — authenticated,
  read — по public URL).
- **Таблицы:** своих нет.
- **Edge-функция:** `list-schedule-projects` — прокси к Airtable «General Project Info».
  Secrets: `AIRTABLE_TOKEN` (required), `AIRTABLE_VIEW` (рекоменд. — вью, что кормит форму,
  иначе вернутся все ~665 записей), `AIRTABLE_STATUS_FIELD` (опц. — префикс метки),
  `AIRTABLE_BASE`/`AIRTABLE_TABLE` (опц., есть дефолты).

## Деплой (ручные шаги на живом Supabase)
1. **Bucket:** применить `supabase/migrations/0004_buildertrend_schedule.sql` в SQL Editor.
2. **Airtable token:** создать Personal Access Token (scope `data.records:read` на базу
   `appucrtf5MBcFXVza`).
3. **Edge-функция:** задеплоить `list-schedule-projects` (Supabase Dashboard → Edge Functions,
   либо `supabase functions deploy list-schedule-projects`) и завести secrets (мин. `AIRTABLE_TOKEN`,
   желательно `AIRTABLE_VIEW`).

## Долги / перенос как есть
- Вебхук зашит в клиенте без подписи (как sales / production-checklist; для секретности —
  edge-прокси + HMAC).
- «Отправка» = fire-and-forget POST, доставку не видим.
- RLS бакета свободные (любой authenticated может править/удалять чужие фото — при желании
  сузить до owner-only).
