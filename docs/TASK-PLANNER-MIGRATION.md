# Task Planner → миграция БД в общий портал-Supabase (HR DASHBOARD)

**Решение (2026-07-10):** Task Planner переезжает из своего Supabase-проекта
`crews scheduling` (`dhtewaqfcsejdllwhgtl`, us-east-2) в **общий проект портала
`HR DASHBOARD`** (`pilxwhtkhysanpukaliu`, us-east-1), как и остальные апки.

---

## ⏸️ ЧЕКПОЙНТ — с чего продолжить (обновлено 2026-07-10)

**Сделано:**
- ✅ Решение + полный план (этот файл).
- ✅ Скачаны 6 edge-функций в `apps/task-planner/supabase/functions/` (`sync-airtable-projects`,
  `sync-airtable-teams`, `sync-airtable-skills`, `sync-team-accounts`, `auto-sync-airtable`,
  `set-team-password`). ⚠️ Внутри `set-team-password/index.ts:23` — хардкод старого publishable-ключа.
- ✅ Проанализировано: 12 таблиц (нашли `sync_logs`), 13 реально нужных секретов из 25
  (2 ключа + 11 Airtable-ID), расширенная схема `tp_profiles`.

**Разделение труда:** секреты (2 ключа `AIRTABLE_API_KEY`/`GOOGLE_PLACES_API_KEY` + 11 Airtable-ID)
Влад добывает и сетит сам на Шаге 4 — они НЕ на критическом пути сейчас.

**СЛЕДУЮЩИЙ ШАГ при возобновлении → Шаг 1 «Дамп схемы»:**
```
supabase db dump --db-url "<CONNECTION_STRING crews scheduling>" --schema public \
  -f <scratchpad>/crews_schema.sql
```
Connection string: dashboard `crews scheduling` → Connect → URI (подставить db password).
CLI может требовать заново `supabase login` (прошлый токен временный, истёк).
Как дамп готов — Клод пишет миграцию `tp_*` (Шаг 2).

**Полный порядок (детали — в разделе «Пошаговый план» ниже):**
1. ⏭️ Дамп схемы `crews scheduling` (Влад) → 2. Миграция `tp_*` SQL (Клод) →
3. Правка кода под `tp_`: `data.ts`+`AuthProvider`+6 edge+`.env` (Клод) →
4. Применить на HR DASHBOARD: миграция + деплой функций + секреты + Airtable-синк (Влад) →
5. n8n: переподключить Supabase + `AI_teams_schedule`→`tp_ai_teams_schedule` (Влад) →
6. E2E-тест (вместе).

---

## Стратегия: изоляция префиксом `tp_`, НЕ слияние

Все таблицы Task Planner переносятся с префиксом **`tp_`**. Мы **не** объединяем
схемы с порталом (не реконсилируем `profiles`/`user_roles`/`projects`) — держим
**параллельные неймспейсы в одном проекте**. Это осознанно самый простой рабочий
путь: правки в коде механические, ноль риска коллизий (сейчас и в будущем), легко
бэкапить/откатывать (всё `tp_*` = Task Planner).

Общий на весь проект остаётся только **`auth.users`** (один список аккаунтов). Роли
и профили Task Planner живут отдельно в `tp_profiles`/`tp_user_roles` и просто
ссылаются на тот же `auth.uid()`. Портальные `profiles`/`roles`/`user_roles` не
трогаются.

### Карта переименования таблиц (11)

| Сейчас (crews scheduling) | Станет (HR DASHBOARD) | Конфликт с порталом? |
|---|---|---|
| `tasks` | `tp_tasks` | нет |
| `teams` | `tp_teams` | нет |
| `projects` | `tp_projects` | **да** |
| `task_types` | `tp_task_types` | нет |
| `skills` | `tp_skills` | нет |
| `team_availability` | `tp_team_availability` | нет |
| `travel_cache` | `tp_travel_cache` | нет |
| `AI_teams_schedule` | `tp_ai_teams_schedule` | нет |
| `profiles` | `tp_profiles` | **да** |
| `user_roles` | `tp_user_roles` | **да** |
| `app_settings` | `tp_app_settings` | **да** |
| `sync_logs` | `tp_sync_logs` | нет |

4 из 12 имён прямо конфликтуют с порталом — префикс обязателен минимум для них;
для единообразия префиксуем все.

> `sync_logs` (12-я таблица) обнаружена в скачанных edge-функциях (лог синков Airtable:
> `status`, `message`, `synced`) — в обращениях фронта её не было.

---

## Что переносим (объём)

1. **Схема 12 таблиц** + внешние ключи между ними + RLS + enum ролей.
   ⚠️ Полного DDL в репозитории НЕТ (в `supabase/migrations/` только 2 патча) —
   схему снимаем дампом из живого проекта `crews scheduling`.
   `tp_profiles` шире, чем в патчах: помимо `id/user_id/email/first_name/last_name`
   ещё `team_id` (→ `tp_teams`, FK), `initial_password`, `account_status`, `account_error`
   (пишутся `sync-team-accounts`/`set-team-password`).
2. **6 edge-функций:** `set-team-password` (есть в репо) + 5 Airtable-синк
   (`sync-airtable-projects`, `sync-airtable-teams`, `sync-airtable-skills`,
   `sync-team-accounts`, `auto-sync-airtable`) — **исходников в репо НЕТ**, качать
   из облака `crews scheduling`.
3. **Секреты:** случай B (в Edge Function Secrets, значения замаскированы). Функции скачаны
   и проанализированы (`Deno.env.get`) — из 25 переменных дашборда РЕАЛЬНО используются **13**:
   - **2 настоящих ключа** (значения не вытащить → пересоздать/у Павла): `AIRTABLE_API_KEY`,
     `GOOGLE_PLACES_API_KEY`.
   - **11 идентификаторов Airtable** (не секреты → из Airtable / Make / n8n через MCP):
     `AIRTABLE_PROJECT_BASE_ID`, `AIRTABLE_PROJECT_TABLE`, `AIRTABLE_PROJECT_VIEW`,
     `AIRTABLE_SKILLS_BASE_ID`, `AIRTABLE_SKILLS_TABLE`, `AIRTABLE_SKILLS_VIEW`,
     `AIRTABLE_TEAM_BASE_ID`, `AIRTABLE_TEAMS_TABLE`, `AIRTABLE_TEAMS_VIEW`,
     `AIRTABLE_TEAMS_BASE_ID`, `AIRTABLE_BASE_ID`.
     (По дайджестам: `AIRTABLE_BASE_ID`=`AIRTABLE_TEAM_BASE_ID`=`AIRTABLE_SKILLS_BASE_ID` — одна база
     `67f21668…`; projects — отдельная `0f5929…`.)
   - **НЕ используются** (игнор): `OPENAI_API_KEY`, `MAPBOX_PUBLIC_TOKEN`, `MAKE_WEBHOOK_URL`,
     все `AIRTABLE_CREW*/CREWS*`, `AIRTABLE_PROJECTS_*`. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` —
     системные, новый проект проставит сам.
   - Плюс захардкоженный publishable-ключ старого проекта в `set-team-password/index.ts:23`
     (`sb_publishable_eVAy…`) → заменить на publishable-ключ HR DASHBOARD.
4. **Пользователи** (`auth.users`) Task Planner + их `tp_profiles`/`tp_user_roles`.
5. **Данные** справочников (teams/projects/skills/task_types) — либо дампом, либо
   перельёт Airtable-синк заново.
6. **n8n:** прод-воркфлоу планировщика (`cit7Gah53xPLLbdy`) пишет в
   `AI_teams_schedule` через Supabase-ноды → переподключить проект + переименовать
   таблицу. n8n **ни разу не запускался в бою** — живых данных нет, переносить
   безопасно.

---

## Ключевые технические решения

- **Auth раздельно.** `tp_profiles`/`tp_user_roles` (enum `super_admin|pm|team_lead`)
  изолированы от портальных. Один человек в обоих контекстах = одна `auth.users`
  запись + по строке в каждом наборе профилей. Логику ролей ни там, ни там не
  переписываем.
- **Пользователей пересоздаём, а не мигрируем 1:1.** Раз система не в бою, проще
  пересоздать аккаунты бригад в общем `auth.users` через `set-team-password` после
  деплоя, чем тащить строки в служебную схему `auth` с сохранением uid. Если
  какие-то реальные аккаунты уже есть — сверить список заранее.
- **Унифицировать двойственность `profiles.id` vs `profiles.user_id`.** Сейчас
  миграция ждёт `profiles.id = auth.uid()`, а edge-функция пишет по `user_id`
  (`data.ts:158,174` читает по обоим). В `tp_profiles` фиксируем **один** ключ —
  `user_id = auth.uid()` — и правим `data.ts:271,282` на `user_id`.
- **Сохранить внешние ключи для embed-запросов.** `data.ts:14-15` делает
  `tasks.select('*, projects(...)')`, `data.ts:331` — `team_availability … teams(name)`.
  Это Supabase-embed через FK. После переименования FK должны указывать на
  `tp_projects`/`tp_teams`, а embed в коде стать `tp_projects(...)`/`tp_teams(...)`.
- **Enum ролей назвать `tp_app_role`** (не занимать общее имя `app_role`).

---

## Пошаговый план

### Фаза 0 — Подготовка и бэкап (ничего не ломаем)
- [ ] `supabase db dump --schema-only` из `crews scheduling` → полный DDL всех таблиц/FK/RLS/enum.
- [ ] `supabase db dump --data-only` нужных таблиц → бэкап данных.
- [ ] `supabase functions download` для всех 6 edge-функций (особенно 5 sync — их нет в репо!).
- [ ] Выписать секреты Airtable из dashboard `crews scheduling` (Project Settings → Edge Functions → Secrets).
- [ ] Зафиксировать список реальных пользователей Task Planner (`auth.users` + `tp_user_roles`).

### Фаза 1 — Схема `tp_*` в HR DASHBOARD
- [ ] Создать enum `tp_app_role` (`super_admin|pm|team_lead`).
- [ ] Прогнать DDL 11 таблиц с префиксом `tp_` + FK: `tp_tasks.project_id→tp_projects`,
      `tp_tasks.team_id→tp_teams`, `tp_team_availability.team_id→tp_teams`, `tp_tasks.request_task_id→tp_tasks`.
- [ ] RLS-политики (адаптировать имена): `tp_app_settings` write через `tp_user_roles.role='super_admin'`;
      `tp_profiles` self (`user_id = auth.uid()`); `tp_user_roles` read own.
- [ ] Сид `tp_app_settings`: `planner_webhook_url` = прод n8n URL.

### Фаза 2 — Пользователи / auth  (УПРОЩЕНО: всё из Airtable)
Бригады — данные из **Airtable** (источник истины), проект не в бою → `auth.users`
и профили **вручную не мигрируем**. Аккаунты и справочники самональются синком.
- [ ] Добавить task-planner origin в **Redirect URLs** проекта HR DASHBOARD (Google OAuth
      входа в планировщик) — как делали для портала.

### Фаза 3 — Данные (УПРОЩЕНО: прогнать Airtable-синк)
- [ ] После деплоя sync-функций (Фаза 4) запустить Airtable-синк → он нальёт `tp_teams`/
      `tp_projects`/`tp_skills`/`tp_task_types` и создаст аккаунты бригад в `auth.users`
      (`sync-team-accounts`/`set-team-password`). Ручной restore данных не нужен.

### Фаза 4 — Edge-функции (деплой в HR DASHBOARD)
- [ ] `set-team-password`: убрать хардкод publishable-ключа (`index.ts:23`) → в env;
      заменить `user_roles→tp_user_roles`, `profiles→tp_profiles`. Deploy.
- [ ] 5 sync-функций: заменить имена таблиц (`projects→tp_projects`, `teams→tp_teams`,
      `skills→tp_skills`, `task_types→tp_task_types`); переустановить Airtable-секреты. Deploy.

### Фаза 5 — Frontend (`apps/task-planner`)
- [ ] `.env`: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` → **HR DASHBOARD** (те же, что у портала).
- [ ] `src/services/data.ts`: переименовать все `.from('X')` → `.from('tp_X')` (12 имён, ~40 мест)
      + embeds `projects(...)→tp_projects(...)`, `teams(name)→tp_teams(name)`; ключи `app_settings→tp_app_settings`.
- [ ] `src/auth/AuthProvider.tsx:47`: `user_roles → tp_user_roles`.
- [ ] `data.ts:271,282`: чтение/запись профиля перевести на `user_id`.
- [ ] `supabase/.temp/linked-project.json` → relink на HR DASHBOARD (`supabase link`).
- [ ] Локальный прогон на :5173.

### Фаза 6 — n8n (прод-воркфлоу `cit7Gah53xPLLbdy`)
- [ ] Supabase-credential в n8n → на проект HR DASHBOARD (URL + service key).
- [ ] Ноды «Create a row» / «Update a row»: таблица `AI_teams_schedule → tp_ai_teams_schedule`.
- [ ] (webhook-URL n8n НЕ меняется — это endpoint n8n, а не Supabase.)

### Фаза 7 — Проверка и заморозка старого
- [ ] E2E: логин → создать задачу → отправить в n8n → поллинг `tp_ai_teams_schedule` → расписание отрисовалось.
- [ ] Airtable-синк наполняет `tp_*`. `set-team-password` создаёт бригадира.
- [ ] `crews scheduling` — **paused, не удалять ~1 мес** (бэкап-окно).

---

## Полный чеклист правок в коде (file:line)

**`src/services/data.ts`** — почти всё здесь:
- `.from()` по таблицам: `tasks` (:14,400,426,433,441,463,517,525,575), `teams` (:22,84,120,147),
  `AI_teams_schedule` (:561,562,615,620), `profiles` (:145,271,282), `user_roles` (:146),
  `task_types` (:233,238,243,321), `skills` (:85,309), `team_availability` (:330,344,353),
  `projects` (:107), `app_settings` (:253,259), `travel_cache` (:654,671).
- embeds: :15 `projects(...)`, :331 `teams(name)`.
- профиль на `user_id`: :271, :282.

**`src/auth/AuthProvider.tsx`** — :47 (`user_roles→tp_user_roles`).

**`.env` / `.env.example`** — Supabase URL/key → HR DASHBOARD (:2,3).

**`supabase/functions/set-team-password/index.ts`** — :23 (хардкод ключа),
:44/:86/:91/:92 (`user_roles`/`profiles` → `tp_`).

**`supabase/.temp/linked-project.json`** — relink.

**5 sync-edge (после download)** — имена таблиц внутри.

---

## Что это ЗАТРОНЕТ

| Область | Затрагивается | Как |
|---|---|---|
| **Frontend task-planner** | да | `.env`, `data.ts` (~40 правок), `AuthProvider.tsx`, relink |
| **Supabase HR DASHBOARD** | да (добавления) | +11 таблиц `tp_`, FK, RLS, enum, +6 edge, +секреты, +юзеры в `auth.users` |
| **n8n** | да | 1 прод-воркфлоу: credential + имя таблицы |
| **Секреты** | да | Airtable-ключи, publishable-ключ |
| **Портал** | **НЕТ** | его таблицы/роли не трогаем; `auth.users` общий — портальные юзеры не ломаются |
| **Проект crews scheduling** | заморозка | paused как бэкап, потом удаление |

---

## Требования (что нужно иметь до старта)

- Доступ к обоим Supabase-проектам (dashboard + Postgres connection string) — для дампа и заливки.
- **Supabase CLI** (db dump, functions download/deploy, link).
- **Airtable API-ключи** для 5 sync-функций. Где взять — зависит от того, как хранятся
  (узнаём на Фазе 0 после `functions download`):
  - **Случай A — ключ зашит в коде функции** → приедет с download, ничего доставать не надо.
  - **Случай B — ключ в Secrets проекта** (`Deno.env.get`) → Supabase значение не покажет
    (маскирует); создать **новый Personal Access Token** в Airtable (airtable.com/create/tokens,
    scopes `data.records:read/write` + `schema.bases:read`) или взять у Павла.
- **Доступ к n8n** — это НЕ API-ключ, а вход в воркспейс `basementremodeling.app.n8n.cloud`
  (есть) + n8n MCP; правка Supabase-credential воркфлоу делается в UI.
- Доступ к n8n прод-воркфлоу (`basementremodeling.app.n8n.cloud`).
- Список реальных пользователей Task Planner (чтобы пересоздать).

---

## Риски и митигации

| Риск | Митигация |
|---|---|
| Нет DDL в репо (10+ таблиц) | `supabase db dump --schema-only` из живого проекта — **первым делом** |
| 5 edge-функций без исходников | `functions download` **до** любых изменений в старом проекте |
| Двойственность `profiles.id`/`user_id` | унифицировать на `user_id` при создании `tp_profiles` |
| Embed-запросы (`tasks→projects`) ломаются без FK | пересоздать FK на `tp_*` таблицы |
| Миграция `auth.users` с сохранением uid сложна | пересоздать аккаунты (система не в бою) + relink `tp_profiles/tp_user_roles/created_by` |
| Переименование `AI_teams_schedule` рассинхронит n8n | Фазу 5 и 6 катить вместе, E2E-тест до заморозки старого |
| Захардкоженный publishable-ключ в edge | вынести в env при передеплое |

---

## Оценка усилий

~**12–17 ч (реалистично ~2 рабочих дня)**: дамп/бэкап/download ~1.5ч, схема `tp_`+FK+RLS
~2–3ч, auth/юзеры ~1–2ч, данные ~1ч, edge (6, из них 5 download+adapt) ~2–3ч, frontend
rename+env+test ~2–3ч, n8n ~1–2ч, E2E+фиксы ~2ч.

> Префиксный подход намеренно **избегает** дорогого слияния `profiles`/`user_roles`
> схем — поэтому это «средняя» сложность (~2 дня), а не «сложная» переделка auth.
