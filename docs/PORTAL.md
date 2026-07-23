# Портал — единый источник правды (статус, аудит, долги)

> Обновлено: **2026-07-23**. Сведено из `PORTAL-STATUS.md` + `PORTAL-AUDIT.md` (оба удалены).
> Охват: `apps/portal` (все приложения — роуты внутри) + общая БД Supabase «HR DASHBOARD»
> `pilxwhtkhysanpukaliu`. Severity: 🔴 высокая · 🟠 средняя · 🟡 низкая · ⚪ принятый риск · ✅ сделано.
> Деплой — см. [`DEPLOYMENT.md`](DEPLOYMENT.md). Подсистема Task Planner (n8n-мозг, бизнес-правила)
> — см. [`TASK-PLANNER.md`](TASK-PLANNER.md) и [`TASK-PLANNER-MIGRATION.md`](TASK-PLANNER-MIGRATION.md).

Портал = единственное приложение: платформа + все внутренние апки роутами, один деплой (статика
за nginx на AWS EC2), одна БД, один вход (Google OAuth + whitelist). Правила платформы — в
корневом [`README.md`](../README.md).

---

## 1. Приложения (собрано, роуты внутри портала)

| Приложение | Роут(ы) | Статус | Заметки |
|---|---|---|---|
| **03-Production Checklist** | `/production-checklist`, `/production-checklist/:id`, `/production-checklist/project/:projectId` | ✅ | QA-чеклист по проектам; tri-state, Send→Make (вебхук в app-settings), AI-импорт |
| **06-HR Checklists** | `/checklists`, `/checklist/:id` | ✅ | Онбординг/оффбординг; дерево ≥3 уровней, tri-state + каскад, PDF (@react-pdf), AI-импорт. Legacy-фазы выпилены осознанно |
| **06-HR Gmail Auto Sender** | `/gmail-auto-sender` | ✅ | Тонкий фронт над edge `gmail-auth`→AWS; своей БД нет |
| **02-Sales — Send an Offer Email** | `/sales-email-sender` | ✅ | Quill-редактор, шаблоны `email_templates`, черновик в localStorage, Send→Make |
| **06-HR Sync Airtable Contacts** | `/hr-sync-airtable` | ✅ | 2 кнопки Sync (POST→Make). Save Schedule — disabled (RPC в БД нет; проверено) |
| **03-Production — Send Buildertrend Schedule** | `/buildertrend-schedule` | ✅ | Селектор проекта (Airtable через edge) + фото → бакет → POST на Make |
| **Task Planner (Daly Schedule)** | `/task-planner`, `/task-planner/{create,availability,admin}` | ✅ | Вплавлен роутами портала (App.tsx), общая БД (таблицы `tp_*`). Свой n8n-«мозг» в проде. Детали — [`TASK-PLANNER.md`](TASK-PLANNER.md) |

Код каждой апки: `apps/portal/src/pages/<app>/*`, `src/services/<app>.ts`, `src/domain/<app>.ts`.
Карточки на «My Applications» открываются: внутренние — навигацией (относительный `applications.url`,
напр. `/checklists`). SSO-хэндофф (`lib/sso.ts`/`openApp`) остаётся для внешних апок на субдоменах.

### Общая оболочка и компоненты
- `components/ui.tsx` — портальная дизайн-система (Button/Card/Modal/Field/Input/Textarea/Tabs/
  Dropdown/StatusBadge/DataTable…). ⚠️ Есть **второй** набор `components/task-planner-ui.tsx`
  (перенесён из TP) — дубли тех же компонентов, свести в один (см. §6 «Остаётся»).
- `lib/imageCompression.ts` (JPEG ≤200KB), кастомные `Dropdown`/`SearchableCombobox`/`DatePicker`.
- Общая edge `extract-checklist-from-image` (HR + Production).
- Хедер/бургер-меню/App Settings — общие из портала; лого всегда ведёт на главную.

---

## 2. App-settings фреймворк (готов)
Настройки **конкретной апки** (не портала).
- Таблица **`app_settings`** (key/value на апку), миграция `0003_app_settings.sql` — прогнана на
  живой БД (2026-07-07), 2 RLS-политики (чтение — любой authenticated, запись — админ через
  `user_has_admin_role`), Save работает. ✅
- Реестр `src/app/appRegistry.ts` — по каждой апке: вебхуки + `resources` (БД/таблицы/бакеты/edge/
  внешние) + роут-префиксы.
- Экран **`/settings/:appCode`** (admin-only), табы: General / Resources / Webhooks.
  Resources — живой (реальные `count` строк + бакеты из `storage.listBuckets()`).
- Сервисы читают вебхуки из БД с фолбэком на env (`resolveString`): Sales, Production-Checklist,
  HR-Sync, Buildertrend.
- **Task Planner — особняк**: своя key/value-таблица `tp_app_settings` (`value text`, без
  `app_code`) и собственный экран `/settings` внутри апки.

---

## 3. Безопасность (SEC)

| # | Что | Статус |
|---|---|---|
| **SEC-1** | Открытые Make/n8n-вебхуки без подписи (прямой `fetch` из браузера, URL в бандле) | ⚪ **Принятый риск** (2026-07-23): внутренний инструмент. При выходе наружу — edge-прокси `send-*` с ролью+секретом |
| **SEC-2** | Per-app route-gate | ✅ **Закрыто** (2026-07-23): `useAppAccess()` + `AppAccessGuard` вокруг app-роутов, admin bypass, «Access denied». Тест `tests/app-access.test.ts` + ручной под ограниченной ролью |
| **SEC-3** | Свободные RLS | ⚪ **Разобрано** (2026-07-23): все PII-таблицы (employee*, checklists*, projects, production_*, project_*) уже скоупнуты `user_has_admin_role`/`user_has_application_access`. Открыта только `email_templates` (несекретные болванки) — оставлена осознанно |
| **SEC-4** | `gmail-auth` edge: `verify_jwt=false` + токен `bmasters2020` в edge | ⚪ **Принятый риск** (тот же класс, что SEC-1) |
| **SEC-5** | Публичные бакеты (фото по прямой ссылке без логина) | ⚪ **Принятый риск** (2026-07-23): внутр. инструмент, ссылки наружу не расходятся. Фикс на будущее — private + signed URLs |
| **SEC-6** | Ссылки пунктов рендерятся `<a href>` без валидации схемы | 🟡 Низкий риск. Стоит резать `javascript:`/`data:` в обоих редакторах |

**Хардкод секретов — НЕТ** (проверено grep'ом по `apps/portal/src` + `git grep`): Supabase URL/anon —
только `import.meta.env`; вебхуки — env + `app_settings`; нет `service_role`/`eval`/
`dangerouslySetInnerHTML`. Косметический справочный хардкод (не секреты): email/AWS-URL в макете
Gmail-consent, cron-времена в справке `appRegistry`/HR-Sync (зеркалят реальный cron, вручную).

---

## 4. Корректность / баги (BUG)

| # | Что | Статус |
|---|---|---|
| **BUG-1** | Прогресс не атомарен (гонка → дубли) | ✅ **Исправлено+применено** (2026-07-23): миграция `0005` (UNIQUE-индексы + дефолты) + `upsertProgress` → `upsert(onConflict)` |
| **BUG-2** | Send не идемпотентен (двойной клик → 2 POST + 2 `Completed`) | 🟠 Открыто. Мягкая защита `checklist_sent_at` не строгая. Фикс — блокировка кнопки + флаг (edge не делаем, см. SEC-1) |
| **BUG-3** | Назначения без UNIQUE | ✅ **Исправлено+применено** (2026-07-23): UNIQUE в `0005`; `assignChecklist` → `upsert(ignoreDuplicates)` |
| **BUG-4** | HR tri-state каскад — приближение (без транзакции) | 🟡 Осознанное упрощение; при плохой сети возможны частичные состояния |
| **BUG-5** | Sales — чистка HTML регулярками (`cleanHtml`) | 🟡 Хрупко к нестандартной разметке; отдельного санитайзера нет |
| **BUG-6** | HR-Sync — расписание read-only + DST | 🟡 Save disabled (RPC нет). ET→UTC=+5 не учитывает EDT. Фикс — `sync_schedules` + cron-RPC + IANA |

### Целостность данных (констрейнты)
- ✅ UNIQUE `project_checklist_progress(project_id, task_id)`, `employee_checklist_progress(employee_id, task_id, phase)`, `project_checklists(project_id, checklist_id)`, `employee_checklists(employee_id, checklist_id)` — миграция `0005`.
- (Опц.) enum на `projects.status` (сейчас свободный text). Дохлая колонка `project_checklist_progress.photos` (в UI не пишется).

---

## 5. Сделано в сквозном заходе (2026-07-23)
Портал стал единственным приложением — прошли ревизией «на готовность к работе»:
- ✅ **SEC-2 route-gate** (см. §3).
- ✅ **BUG-1/BUG-3 UNIQUE-констрейнты** + миграция `0005` применена на боевой БД (см. §4).
- ✅ **SEC-1/3/4/5 разобраны** — приняты как риск (внутренний инструмент) или уже закрыты (см. §3).
- ✅ **Код-сплит по роутам** (`React.lazy` + `Suspense` в Layout): ядро бандла **2.2 МБ → ~503 кБ**
  (gzip 146 кБ); тяжёлое (@react-pdf 1.3 МБ в HR-чеклистах, Quill 226 кБ в Sales, dnd/Maps в TP)
  грузится по требованию.
- ✅ **Прод-деплой** на AWS EC2 (nginx, HTTPS) — см. [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## 6. Остаётся / долги

### Готовность к работе
- [ ] **Адаптив планшет/мобилка** (запрошено 2026-07-22). Сейчас вёрстка десктопная: на узких
      экранах хедер наезжает (лого перекрывает заголовок), сетки задач/карточек не перестраиваются,
      широкие `DataTable` (Admin, Users) выходят за экран, модалки на весь вьюпорт. Объём — все апки
      + общие экраны. Делать: брейкпоинты `sm/md/lg` в `app/Layout.tsx`, сетки в одну колонку,
      скролл/карточки для таблиц, тач-френдли drag-n-drop.
- [ ] **Свести две дизайн-системы в одну**: перевести экраны Task Planner с `task-planner-ui.tsx`
      на портальный `ui.tsx`, удалить дубль. Консистентность + меньше кода + одна точка правок.
- [ ] **Данные/запросы**: пройтись по N+1, инвалидации react-query, остаткам старых имён таблиц/embed'ов.

### По приложениям
- [ ] **HR-Sync**: сделать расписание реально редактируемым (`sync_schedules` + cron-RPC), таймзона
      через IANA `America/New_York` (BUG-6).
- [ ] **HR Legacy-фазы**: выпилены; при необходимости завести контент обычными шаблонами через редактор.
- [ ] **BUG-2**: гасить двойной Send на клиенте (кнопка disabled + флаг).

### Прочее из платформы
- [ ] **Тесты доступа**: приглашённый — первый вход создаёт профиль+роль (нужен реальный тест-юзер;
      `dev@todor3d.com` не годится — Internal-consent Google блокирует).
- [ ] **Аудит RLS на escalation** (не осталось ли дырявой Lovable-политики повышения роли).
- [ ] **Вкладка Applications** в UI (сейчас апку добавляем SQL).
- [ ] **SSO-консюмер в `packages/lib`** (к деплою апки на отдельный субдомен, если понадобится).

> Порты/OAuth: локальный dev — **:5175** (`vite.config.ts`). Прод-Redirect URL
> `https://internal-apps.basementremodeling.com/**` добавлен в Supabase (детали — `DEPLOYMENT.md`).

---

## 7. Что было лучше, чем в Lovable (платформа)
- Свой фронт вне Lovable (Vite+React+TS), код-сплит, тесты.
- Whitelist-поток в наших руках (триггер первого входа → авто-профиль+роли).
- Invited-строки + Revoke в Users; ловля «тихого no-op» RLS (явная ошибка вместо ложного успеха).
- SSO-хэндофф (сессия дочерним апкам через URL-fragment).
- Модалки: ограничение высоты + внутренний скролл + блок скролла фона.

## 8. С клиентом обсудить
- [ ] Судьба **дубля** «Pavel Abaev» (два профиля: HR Manager и Admin).
- [x] Домены Workspace — ✅ подтверждено (2026-07-10): валидны ОБА (`basementremodeling.com` +
      `achgroupllc.com`), юзеры обоих в whitelist. Учитывать оба при доступе.
- [ ] Согласовать прод-домены/субдомены (если будут отдельные апки на субдоменах).
