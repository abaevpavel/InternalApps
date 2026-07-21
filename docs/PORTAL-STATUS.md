# Портал — статус миграции с Lovable (памятка)

> Обновлено: 2026-07-21. Портал `apps/portal`, БД — существующий Supabase
> «HR DASHBOARD» `pilxwhtkhysanpukaliu` (переиспользуем, данные там же).
> Все внутренние приложения — **роуты внутри портала** (один деплой, общая БД).
> Отдельный по деплою только **Task Planner** (свой origin, открывается в новой вкладке
> с SSO), но с 2026-07-21 он работает в **той же БД** — его таблицы с префиксом `tp_`.

---

## Приложения (собрано, роуты внутри портала)

| Приложение | Роут(ы) | Статус | Заметки |
|---|---|---|---|
| **03-Production Checklist** | `/production-checklist`, `/production-checklist/:id`, `/production-checklist/project/:projectId` | ✅ собрано | QA-чеклист по проектам; tri-state, Send→Make (вебхук в app-settings), AI-импорт |
| **06-HR Checklists** | `/checklists`, `/checklist/:id` | ✅ собрано | Онбординг/оффбординг; дерево ≥3 уровней, tri-state + каскад, PDF (@react-pdf), AI-импорт. **Legacy-фазы выпилены осознанно** |
| **06-HR Gmail Auto Sender** | `/gmail-auto-sender` | ✅ собрано | Тонкий фронт над edge `gmail-auth`→AWS; БД нет |
| **02-Sales — Send an Offer Email** | `/sales-email-sender` | ✅ собрано | Quill-редактор, шаблоны `email_templates`, черновик в localStorage, Send→Make |
| **06-HR Sync Airtable Contacts** | `/hr-sync-airtable` | ✅ собрано | 2 кнопки Sync (работают, POST→Make). **Save Schedule — disabled с англ. подсказкой** (RPC в БД нет; проверено) |
| **Task Planner** | внешний `http://localhost:5173`/прод | ✅ мигрирован | Отдельный деплой, **общая БД** (таблицы `tp_*`); в реестре `appRegistry` заведён как `externalUrl`-апка; своё меню/App Settings приведены к портальному виду |

Код каждой апки: `apps/portal/src/pages/<app>/*`, `src/services/<app>.ts`, `src/domain/<app>.ts`.
Карточки на «My Applications» открываются: внутренние — навигацией (относительный `applications.url`, напр. `/checklists`); внешние (Task Planner, абсолютный URL) — в новой вкладке с SSO.

### Общие компоненты
`components/ui.tsx` (Button/Card/Modal/Field/Input/Textarea/Tabs/**Dropdown**/StatusBadge/DataTable…),
`lib/imageCompression.ts` (JPEG ≤200KB), кастомные `Dropdown`/`SearchableCombobox`/`DatePicker`,
общая edge `extract-checklist-from-image` (HR + Production).

---

## App-settings фреймворк (готов)
Настройки **конкретного приложения** (не портала).
- Таблица **`app_settings`** (key/value на апку) — миграция `0003_app_settings.sql`, **чтение — любой authenticated, запись — админ** (`user_has_admin_role`). ✅ **Прогнано на живой БД** (2026-07-07): таблица есть, 2 RLS-политики, Save работает.
- Реестр `src/app/appRegistry.ts` — по каждой апке: вебхуки + `resources` (БД/таблицы/бакеты/edge/внешние) + роут-префиксы.
- Экран **`/settings/:appCode`** (admin-only) с табами: **General** (описание проекта), **Resources**, **Webhooks** (если есть).
- **Resources — живой**: реальные `count` строк по таблицам + реальные бакеты (public/private из `storage.listBuckets()`); edge/external — declared (с клиента не интроспектируются).
- Вход — **контекстный пункт «App Settings»** в хедер-меню (админ + внутри апки).
- Сервисы читают вебхуки из БД с фолбэком на env (`resolveString`): Sales, Production-Checklist,
HR-Sync, Buildertrend-Schedule. **Task Planner — особняк**: у него своя key/value-таблица
`tp_app_settings` (`value text`, без `app_code`) и собственный экран `/settings` внутри апки;
портальная `app_settings` (`value jsonb`, с `app_code`) его не обслуживает.

---

## Рекомендации / долги (сделать потом)

### Доступ и безопасность
- [ ] **Per-app route-gate** (`AppAccessProtected`): сейчас карточки на главной фильтруются по роли ✅, но **прямой URL к чужой апке не закрыт** (любой залогиненный зайдёт). План: хук `useAppAccess()` (доступные `applications.url` юзера) + обёртка роутов; admin bypass; экран «Access denied». Тест — под ограниченной ролью.
- [ ] **Ужесточить RLS** (дополняем позже, возможно): у части таблиц политики «любой authenticated» → данные достижимы прямым API-запросом даже без route-доступа. Кандидаты: `email_templates` (owner/роль Sales), проверить checklist-таблицы. Route-gate = UI-слой; строгая изоляция данных = RLS.
- [ ] **Секретность вебхуков**: все Make-вебхуки сейчас дёргаются прямым `fetch` из браузера (URL виден в Network, без HMAC). Правильно — **edge-прокси** (`send-*`) с ролевой проверкой + секрет + лог. app-settings делает URL редактируемым, но не скрывает.
- [ ] **gmail-auth**: `verify_jwt=false` + захардкоженный AWS-токен = открытый прокси → secrets + `verify_jwt=true` + admin-check.

### По приложениям
- [ ] **HR-Sync**: сделать расписание реально редактируемым (таблица `sync_schedules` + рабочие cron-RPC), таймзона через IANA `America/New_York` (сейчас ET→UTC = +5, летом EDT уезжает на час). Сейчас — read-only + честная подсказка.
- [ ] **Приватность фото**: бакеты `production-checklist-photos`, `checklist-item-photos`, `checklist-photos` — public. Рекомендация: private + signed URLs.
- [ ] **HR Legacy-фазы**: выпилены; при необходимости завести их контент обычными шаблонами через редактор.
- [ ] **Sales**: `updated_at` теперь проставляется явно; RLS `email_templates` — сузить до owner/роли.

### Прочее из платформы (ранее)
- [ ] **Тесты доступа**: не-админ видит только свои апки, нет User Management; приглашённый — первый вход создаёт профиль+роль. (`dev@todor3d.com` не годится — Internal-consent Google блокирует.)
- [ ] **Аудит RLS на escalation** (не осталось ли дырявой Lovable-политики повышения роли).
- [ ] **SSO-консюмер в `packages/lib`** (к деплою первой апки на субдомен).
- [ ] **Прод-деплой** + прод-URL в Google/Supabase Redirect. Локально портал на **:5173** (порт в whitelist Supabase; иначе OAuth редиректит на прод).
- [ ] **Вкладка Applications** в UI (сейчас апку добавляем SQL).

---

## Что было лучше, чем в Lovable (платформа)
- Свой фронт вне Lovable (Vite+React+TS).
- Whitelist-поток в наших руках (триггер первого входа → авто-профиль+роли).
- Invited-строки + Revoke в Users; ловля «тихого no-op» RLS (явная ошибка вместо ложного успеха).
- SSO-хэндофф (сессия дочерним апкам через URL-fragment).
- Модалки: ограничение высоты + внутренний скролл + блок скролла фона (правка `ui.Modal`).

## С клиентом обсудить/сделать
- [ ] Судьба **дубля** «Pavel Abaev» (два: HR Manager и Admin).
- [x] Подтвердить домены Workspace — ✅ подтверждено клиентом (2026-07-10): валидны ОБА
      (basementremodeling.com + achgroupllc.com), юзеры обоих уже в whitelist. Учитывать оба при доступе.
- [ ] Согласовать **прод-домены/субдомены** (для Redirect URIs).
