# Daly Schedule — аудит фронта: хардкод, dev-механика, дыры

> Дата: 2026-06-29. Источник: свип `frontend/src` + сверка с SPEC/MIGRATION.
> Цель: довести до прод-стандарта — ноль хардкода данных, ноль тест-механики в проде,
> закрытые состояния (loading/error/validation), типобезопасность.

Легенда приоритетов: **P0** — блокер прода · **P1** — нужно до релиза · **P2** — качество/долг.

---

## 1. Захардкоженные данные (должны идти из БД/конфига)

| # | Где | Что не так | Действие | Prio |
|---|-----|-----------|----------|------|
| H-1 | `services/data.ts:452` `TEST_ANCHOR_TIMES` | Вшиты 3 конкретных `task_id` + времена 09/11/12 для теста | Удалить вместе с тест-циклом (см. D-блок) | **P0** |
| H-2 | `pages/CreateTask.tsx:145` | В Priority только `5 - Normal` и `1 - Highest` | Полный диапазон 1–10 из конфига (`lib/config.ts`), не из БД | **P1** |
| H-3 | `pages/Login.tsx:46` | Плейсхолдер домена `you@todor3d.com` | В `VITE_ORG_DOMAIN` или нейтральный плейсхолдер | **P2** |
| H-4 | `services/data.ts` роль Team Lead | ✅ уже исправлено — выводится из членства в `teams`, super_admin из `user_roles` | — | done |
| — | `services/n8n.ts:4-6` вебхуки | В `env`, не в коде — ОК | при проде убрать `*_TEST_WEBHOOK` | P1 |

> **Приоритеты — это конфиг, не БД.** H-2: справочник из 10 фиксированных значений уместно
> держать в `lib/config.ts` (единый источник для CreateTask + фильтров), а не в Supabase.

---

## 2. Dev-only / тест-механика (убрать или спрятать за флаг для прода)

Прод-модель (SPEC §4): задача = **одна строка**, плавный переход `requested → proposed → scheduled`.
Текущий тест-каркас создаёт копии и якоря — это надо снять.

| # | Где | Что | Действие | Prio |
|---|-----|-----|----------|------|
| D-1 | `pages/Tasks.tsx:218` | Кнопка **«Test Send to AI»** (`send.mutate(true)` → test-webhook) | Удалить (или за `import.meta.env.DEV`) | **P0** |
| D-2 | `pages/Tasks.tsx:207` | Кнопка **«↺ Reset test set»** (восстановление эталона + TEST_ANCHOR_TIMES) | Удалить | **P0** |
| D-3 | `services/data.ts:387` `materializeProposedCopies()` | Создаёт КОПИИ в `proposed` | Заменить на плавный переход статуса (update, без копий) | **P0** |
| D-4 | `services/data.ts:424` `deleteTasksByStatus()` | Вайп proposed между тестами | Удалить из прод-пути | **P0** |
| D-5 | `services/data.ts:435` `replaceProposedWithSchedule()` | Обёртка delete+insert | Переписать на in-place update по `task_id` | **P0** |
| D-6 | `services/data.ts:458` `restoreRequestedFromRun()` | Восстановление + патч TEST_ANCHOR_TIMES | Удалить | **P0** |

> Решение D-3…D-6 — это и есть пункт SPEC §4 «прод: плавный переход статусов».
> Один источник истины по строке задачи, статус-машина вместо дублирования.

---

## 3. Дыры / недоделки (функциональность)

| # | Где | Дыра | Действие | Prio |
|---|-----|------|----------|------|
| G-1 | `pages/Profile.tsx:27,37` | «Save Profile» и «Update Password» — **мёртвые** (нет onClick/мутаций) | `updateProfile()` (profiles) + `supabase.auth.updateUser({password})`; loading/error/success | **P1** |
| G-2 | `pages/Availability.tsx:14` | Форма «Add Unavailable Period» **не работает** — нет state, мутации, валидации; delete-иконка без onClick | `createAvailability()`/`deleteAvailability()` в data.ts; state + валидация (end>start) | **P1** |
| G-3 | `pages/MyApplications.tsx:55` | **User Management** — `alert('coming soon')` | Реализовать экран L-02 после ответов клиента (§MIGRATION 7) или скрыть пункт | P1/блок |
| G-4 | `pages/CreateTask.tsx` | Слабая валидация: время не проверяется, `tfEnd>tfStart` нет, дата может быть в прошлом, нет запрета Exact без времени (SPEC §5.1) | Добавить клиентскую валидацию (zod или ручную) | **P1** |
| G-5 | `services/maps.ts:20` + `Tasks.tsx` | Если Google SDK не загрузится — тихий фолбэк на haversine, юзер не знает что travel грубый | Поймать ошибку, показать warning-бэйдж «approx travel» | **P1** |
| G-6 | `pages/Availability.tsx:7`, `Admin.tsx` | `useQuery` без `isError`/`isLoading` UI — при падении пусто и молча | Везде показывать loading-скелетон + error-строку | **P1** |
| G-7 | `pages/Tasks.tsx:536` | `comments_ai_1/2` парсятся как `any[]` без валидации структуры | Типы/zod-схема на AI-комментарии | **P2** |
| G-8 | `services/data.ts` (mapDb*) | `Record<string,any>` для строк Supabase — ОК на границе, но `any` течёт дальше | Типизировать клиент Supabase (`Database` типы) / adapter unknown→Task | **P2** |

---

## 4. Прод-провязка (из MIGRATION §5 — статус)

| Пункт | Статус | Действие |
|-------|--------|----------|
| env прод (Supabase/n8n/Google) | 🟡 stage-креды | Завести прод-env, убрать `*_TEST_WEBHOOK` |
| Send to AI: SMS → Pull (без блок-поллинга) | 🟡 поллинг есть | SPEC §6.2: убрать блокирующий поллинг |
| Прод-модель задач (1 строка, плавный статус) | 🔴 тест-каркас | D-3…D-6 |
| Slack workflow `aa6XaAQ6` + `TEAM_TO_USER` | 🔴 | включить, заполнить slack_user_id |
| RLS на `tasks`/`profiles`/`user_roles` под роли | 🟡 включён, политики не подтверждены | подтвердить под прод-роли |
| Google Maps прод-ключ (referrer = прод-домен) | 🔴 restricted на :5174 | прод-ключ + домен |
| Хостинг фронта | 🔴 не выбран | выбрать платформу + домен |
| Ротация `service_role` | 🔴 | ротировать перед продом |

---

## 5. Паритет с Lovable (MIGRATION §4)

| Экран | Новый фронт | Гэп |
|-------|-------------|-----|
| L-01 My Applications (портал) | 🟢 есть | ОК как хаб |
| L-02 User Management | 🔴 нет (alert) | реализовать / решить по §7 |
| L-03 My Account | 🟡 Profile есть, но кнопки мёртвые (G-1) | дореализовать |
| ПМ-вью (team_lead, урезанное) | 🔴 нет | спроектировать после ответов клиента (D2/D3 §7) |

---

## 6. Открытые вопросы клиенту (блокируют часть работ)

- 🕗 Строгие рабочие часы (старт/конец/лимиты) — нет hard-constraint → возможны вечерние смены.
- Роли/RLS внутри Task Planner + состав ПМ-вью (MIGRATION §7 D).
- User Management: кто заводит юзеров, как раздаётся доступ (§7 B/C).
- Slack: где `slack_user_id`, формат payload.
- Архив `scheduled`/срок хранения.

---

## 7. Рекомендованный порядок

**P0 — прод-модель (снять тест-каркас):** D-1…D-6 + H-1. Заменить копии/restore на
плавный переход статуса по `task_id`. Это разблокирует чистую траекторию
`requested → proposed → scheduled`.

**P1 — добить функциональность:** G-1 (Profile), G-2 (Availability), G-4 (валидация
CreateTask + запрет Exact без времени), G-5/G-6 (Maps fallback + loading/error UI),
H-2 (приоритеты), env/Google/Slack прод-провязка.

**P2 — тех-долг:** G-7/G-8 (типизация AI-комментариев и клиента Supabase), H-3.

**Заблокировано клиентом:** User Management (L-02), ПМ-вью, строгие рабочие часы, RLS-политики.
