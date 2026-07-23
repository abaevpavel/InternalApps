# Портал — сквозной аудит (дыры, баги, что фиксить)

> Обновлено: 2026-07-07. Охват: `apps/portal` (все приложения-роуты) + общая БД
> `pilxwhtkhysanpukaliu`. Один общий документ. Severity: 🔴 высокая · 🟠 средняя · 🟡 низкая.
> Многое унаследовано от Lovable («перенос как есть») — помечено.

---

## TL;DR
- **Хардкод секретов — НЕТ.** Ни anon-ключа, ни service_role, ни функциональных вебхуков в
  исходниках; вся конфигурация через `import.meta.env` + `app_settings`. (Детали ниже.)
- Основные риски — **унаследованные от Lovable**: открытые Make-вебхуки без подписи, свободные
  RLS на части таблиц, `gmail-auth` с `verify_jwt=false`, публичные бакеты.
- Наш новый долг: **нет per-app route-gate** (прямой URL к чужой апке открыт залогиненному).
- Несколько мест без атомарности/идемпотентности (гонки при быстрых кликах) — из-за отсутствия
  UNIQUE-констрейнтов в БД.

---

## 1. Хардкод — результат аудита ✅ (в основном чисто)
Проверено grep'ом по `apps/portal/src` (`https?://`, `eyJ…`, `service_role`, `bearer`, вебхук-хвосты,
emails) и `git grep` по отслеживаемым файлам.

**Чисто:**
- Supabase URL/anon-key — только `import.meta.env` (`lib/supabase.ts`); в git не утекли (`.env` в `.gitignore`).
- Все Make-вебхуки — через `env` + `app_settings` (`resolveString`), в коде хвостов нет.
- Нет `service_role`, `dangerouslySetInnerHTML`, `eval`, `TODO/FIXME`.

**Косметический/справочный хардкод (не секреты, но может устаревать):** 🟡
- `pages/gmail-sender/GmailAutoSender.tsx` — в макете Google-warning зашиты `abaevb@gmail.com` и
  `3mb71kyw2k.execute-api…amazonaws.com` (воссоздание consent-экрана, только отображение).
- `app/appRegistry.ts` — AWS-URL и cron-времена (11:00/17:00…) в справке Resources (информативно).
- `pages/hr-sync/HRSyncAirtable.tsx` — cron-времена в read-only блоке (зеркалят реальный cron;
  при изменении cron не обновятся автоматически).
- `.env.example` содержит **реальные** URL вебхуков (не секрет — вебхуки и так публичны, но по-хорошему
  плейсхолдеры).
> Рекомендация: не критично. При желании — вынести email/AWS-URL Gmail-макета в конфиг; cron-времена
> тянуть из БД/edge (см. §4 HR-Sync).

---

## 2. Безопасность

### ⚪ SEC-1. Открытые Make-вебхуки без подписи — ПРИНЯТЫЙ РИСК (решение 2026-07-23)
Send (Production-Checklist), Sales, HR-Sync, Buildertrend, Task Planner — прямой `fetch` из браузера,
URL виден в Network/бандле, без HMAC. **Решено не чинить: это внутренний инструмент** (узкий круг
залогиненных сотрудников, не публичный сервис) — edge-прокси не оправдан. Если инструмент когда-либо
откроют шире/наружу — вернуться к edge-прокси (`send-*` с ролевой проверкой + секрет + лог).

### ✅ SEC-2. Per-app route-gate — ЗАКРЫТО (2026-07-23)
Было: карточки фильтруются по роли, но роуты не гейтятся (прямой URL к чужой апке открыт).
Сделано: `useAppAccess()` (доступные апки юзера) + `AppAccessGuard` вокруг всех app-роутов в
`App.tsx`, admin bypass, экран «Access denied»; маппинг `applications`→код покрыт
`tests/app-access.test.ts`. Ручной тест под ограниченной ролью — пройден 2026-07-23 (чужой URL → «Access denied»). ✅

### 🟠 SEC-3. Свободные RLS на части таблиц (унаследовано)
У ряда таблиц политика «любой authenticated» → данные достижимы прямым API-запросом даже без
route-доступа. Подтверждено: `email_templates` (Sales) — read/write всем. Проверить checklist-таблицы.
**Фикс:** owner/роль на UPDATE/DELETE. (Дополняем RLS позже — по решению.)

### ⚪ SEC-4. `gmail-auth` edge: `verify_jwt=false` + захардкоженный AWS-токен — ПРИНЯТЫЙ РИСК (2026-07-23)
Открытый прокси к AWS, токен `bmasters2020` в edge-функции (не в нашем клиенте). Тот же класс, что SEC-1:
внутренний инструмент → не чиним. При расширении наружу — secrets + `verify_jwt=true` + admin-check.

### 🟠 SEC-5. Публичные бакеты (унаследовано)
`production-checklist-photos`, `checklist-item-photos`, `checklist-photos` — public: фото сотрудников/
стройплощадок по прямой ссылке без авторизации. **Фикс:** private + signed URLs.

### 🟡 SEC-6. Ссылки пунктов рендерятся как `href` без валидации схемы
`ChecklistItem.links[].url` → `<a href={url}>`. HR-редактор нормализует (`https://` если нет протокола),
но стоит явно резать `javascript:`/`data:` схемы в обоих редакторах. Низкий риск (правят только
авторизованные).

---

## 3. Корректность / баги

### ✅ BUG-1. Прогресс не атомарен — ИСПРАВЛЕНО в коде (2026-07-23; нужно применить миграцию)
Было: `upsertProgress` (production + hr) = read-then-write без UNIQUE → двойной клик мог плодить дубли.
Сделано: миграция `0005_progress_assignment_uniques.sql` (дедуп + DEFAULT на NOT NULL-колонки +
UNIQUE-индексы) и оба `upsertProgress` переведены на `upsert(onConflict)`. **⚠️ Миграцию 0005 надо
прогнать на боевой БД — код уже опирается на onConflict (без индекса upsert упадёт 42P10).**

### 🟠 BUG-2. Send не идемпотентен
Production-Checklist Send: двойной клик → два POST в Make + два `Completed`. Мягкая защита (проверка
`checklist_sent_at` вызывающим) не строгая. **Фикс:** серверная идемпотентность (в edge SEC-1) или
блокировка кнопки + флаг.

### ✅ BUG-3. Назначения без UNIQUE — ИСПРАВЛЕНО в коде (2026-07-23; нужно применить миграцию)
Было: `project_checklists` / `employee_checklists` без UNIQUE `(…_id, checklist_id)`, защита от дублей
проверкой в коде (гонка). Сделано: UNIQUE-индексы в миграции 0005; `assignChecklist` (hr) → идемпотентный
`upsert(onConflict, ignoreDuplicates)`. `assignTemplate` (project) остаётся delete+insert (см. хвост миграции).

### 🟡 BUG-4. HR tri-state каскад — приближение
Состояние родителя — производное от листьев (не хранится отдельной строкой), каскад императивный без
транзакции. Функционально эквивалентно, но при плохой сети возможны частичные состояния. Осознанное
упрощение vs оригинал.

### 🟡 BUG-5. Sales — чистка HTML регулярками
`cleanHtml` эмпирическая (пустые `<p>`, `</p>→<br>`, схлопывание `<br>`). Хрупко к нестандартной
разметке. Работает для типовых писем; отдельного санитайзера нет.

### 🟡 BUG-6. HR-Sync — расписание read-only + DST
«Save Schedule» — disabled (RPC в БД нет, проверено). Времена read-only зеркалят реальный cron.
Оригинальный ET→UTC=+5 не учитывал EDT. **Фикс (если надо редактируемое):** таблица `sync_schedules`
+ рабочие cron-RPC + IANA `America/New_York`.

---

## 4. Целостность данных (констрейнты)
- ✅ UNIQUE `project_checklist_progress (project_id, task_id)` — BUG-1 (миграция 0005).
- ✅ UNIQUE `employee_checklist_progress (employee_id, task_id, phase)` — BUG-1 (миграция 0005).
- ✅ UNIQUE `project_checklists (project_id, checklist_id)`, `employee_checklists (employee_id, checklist_id)` — BUG-3 (миграция 0005).
- (Опц.) enum на `projects.status` (сейчас свободный text).
- Дохлые колонки: `project_checklist_progress.photos` (в UI не пишется).

---

## 5. Требует действия СЕЙЧАС (иначе часть не работает)
- [x] **Прогнать `apps/portal/supabase/migrations/0003_app_settings.sql`** — ✅ СДЕЛАНО (прогнано на
      живой БД HR DASHBOARD 2026-07-07; таблица `app_settings` есть, 2 RLS-политики, Save работает).
- [ ] Локальный портал держать на **:5173** (порт в whitelist Supabase Auth; иначе OAuth редиректит на прод).

---

## 6. Приоритезированный чек-лист фиксов
1. ✅ **SEC-2 route-gate** — СДЕЛАНО и проверено под ограниченной ролью (2026-07-23).
2. ⚪ **SEC-1 edge-прокси вебхуков** — ПРИНЯТЫЙ РИСК (внутренний инструмент, не чиним). BUG-2 (дубли Send) — гасить на клиенте.
3. ✅ **UNIQUE-констрейнты** (BUG-1/BUG-3) — код готов (миграция 0005); осталось прогнать SQL на боевой БД.
4. 🟠 **RLS-сужение** (SEC-3) — по таблицам, «дополняем позже».
5. 🟠 **Приватные бакеты** (SEC-5) + `gmail-auth` hardening (SEC-4).
6. 🟡 Косметика/линки (SEC-6), Sales-санитайзер (BUG-5), HR-Sync реальное расписание (BUG-6).

> Ничего из 🔴/🟠 не блокирует текущую работу приложений — это укрепление перед продом.
> Связано с рекомендациями в [PORTAL-STATUS.md](PORTAL-STATUS.md).
