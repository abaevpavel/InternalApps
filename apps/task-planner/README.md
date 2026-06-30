# Daly Schedule — Frontend (новая версия взамен Lovable)

Веб-приложение для планирования дневных расписаний бригад basementremodeling.com
(регион DC/MD/VA). Заменяет текущий фронт на Lovable, чей AI-генерируемый код
плохо работает (главное — каскадный пересчёт времён ломает якоря, см. §8).

> Это документ архитектуры. Сначала согласуем его, потом пишем код.
> Бэкенд (n8n-планировщик + Supabase) уже существует — разбор в
> [`../cit7-prod-analysis.md`](../cit7-prod-analysis.md),
> [`../cit7-deep-audit.md`](../cit7-deep-audit.md).

---

## 1. Назначение и роль в системе

ПМ (project manager) создаёт задачи на день → отправляет их AI-планировщику (n8n)
→ получает черновое расписание по бригадам → правит вручную → одобряет →
рассылает бригадам в Slack.

Полный цикл:

```
[Create Task] → Requested → (Send to AI → n8n) → Proposed → (правки + Approve) → Scheduled → (Send tasks → Slack)
```

Справочники (Projects, Teams, Skills, Task Types) приходят из Airtable через синк
в Supabase. Недоступность бригад задаётся вручную.

---

## 2. Стек

- **React 18 + Vite + TypeScript** — SPA.
- **TanStack Query** — серверное состояние (загрузка/кэш/поллинг Supabase).
- **Zustand** — локальное UI-состояние редактирования расписания (черновик до сохранения).
- **Supabase JS** — БД, Auth, Realtime (опц.).
- **Google Maps JS API** — Places Autocomplete (адреса доп.остановок) +
  **Distance Matrix** (travel-времена, источник истины).
- **React Router** — роутинг разделов.
- **Tailwind CSS + shadcn/ui** — вёрстка (близко к текущему виду).
- **dnd-kit** — drag-and-drop задач.
- **Zod** — валидация payload'ов и форм.
- **date-fns / Luxon** — работа со временем в зоне `America/New_York`.

---

## 3. Слои архитектуры

```
┌─────────────────────────────────────────────┐
│ UI (pages + components, shadcn/ui)           │
├─────────────────────────────────────────────┤
│ State                                        │
│  • TanStack Query — серверные данные          │
│  • Zustand — черновик расписания (editing)    │
├─────────────────────────────────────────────┤
│ Domain                                       │
│  • scheduling-engine (anchor-aware, чистый)   │  ← ядро, без I/O, юнит-тестируемо
│  • validators (zod), formatters               │
├─────────────────────────────────────────────┤
│ Services (адаптеры I/O)                      │
│  • supabaseClient  — CRUD задач/справочников   │
│  • n8nClient       — вебхуки планировщик/Slack │
│  • mapsClient      — Distance Matrix + Places  │
│  • aiResultPoller  — авто-поллинг output_data  │
├─────────────────────────────────────────────┤
│ Supabase (Postgres + Auth) ↔ n8n ↔ Google     │
└─────────────────────────────────────────────┘
```

**Принцип:** `scheduling-engine` — чистая функция без сети и React. Весь пересчёт
времён (включая якоря и доп.остановки) живёт там и покрыт тестами. UI только
вызывает движок и рисует результат. Это противоположность тому, что в Lovable
(пересчёт размазан по `lovable.js` и ломает якоря).

---

## 4. Модель данных (Supabase)

> Сейчас задачи нигде не персистятся — летят сразу в AI и оседают только в
> `AI_teams_schedule`. Чиним: задача становится первоклассной сущностью.

### 4.1 Справочники (синк из Airtable)
- **`projects`** — `id, airtable_id, name, address, lat, lng, project_manager, ...`
- **`teams`** — `id, airtable_id, name, home_address, lat, lng, slack_user_id, skills[]`
- **`skills`** — `id, airtable_id, name, category, description, available_team_ids[]`
- **`task_types`** — `id, name` (Project task / Other ...)
- **`team_availability`** — `id, team_id, start_date, end_date` (недоступность)
- **`profiles`** — `id (=auth.uid), first_name, last_name, email`
- **`user_roles`** — `id, user_id (→auth.users), role (app_role), created_at`
  (РЕАЛЬНАЯ таблица в Supabase-проекте «crews scheduling»; enum `app_role`:
  `super_admin` \| `pm` \| `team_lead`; 7 RLS-политик). Роль хранится здесь,
  а не в `profiles`.

### 4.2 Задачи (новое — ядро фикса)
**`tasks`**
| поле | тип | примечание |
|---|---|---|
| `id` | uuid | PK |
| `status` | enum | `requested` \| `proposed` \| `scheduled` \| `archived` |
| `task_type` | text | Project task / Other |
| `project_id` | uuid? | null для Other |
| `description` | text | |
| `scheduled_date` | date | |
| `time_type` | enum? | `exact` \| `timeframe` \| null |
| `exact_time` | time? | если `exact` → это **якорь** |
| `timeframe_start`,`timeframe_end` | time? | если `timeframe` |
| `estimated_duration_min` | int | **храним в минутах** (не часах!) |
| `task_address`,`lat`,`lng` | | из проекта или ручной (Other) |
| `project_manager` | text | |
| `assigned_team_id` | uuid? | null = unassigned (для AI) |
| `priority` | int | 1..n (5 = normal) |
| `required_skill_ids` | uuid[] | |
| `schedule_prompt` | text? | подсказка планировщику по задаче |
| `additional_stop` | jsonb? | `{ when:'before'\|'after', address, lat, lng, duration_min, travel_to_min, travel_from_min }` |
| `created_by`, `created_at`, `updated_at` | | |

> Поле «доп. обязательная задача, подсветить перед клиентом» — отложено
> (см. Open Questions), смысл уточняется.

**`schedule_runs`** (заменяет/обёртка над `AI_teams_schedule`)
| поле | тип |
|---|---|
| `request_id` | text (PK) |
| `status` | `processing` \| `done` \| `error` |
| `input_body` | jsonb |
| `output_data` | jsonb (план по бригадам) |
| `comments_ai_1`, `comments_ai_2` | jsonb |
| `error` | text? |
| `created_at`, `updated_at` | |

**`scheduled_tasks`** — снимок одобренного расписания (после Approve):
позиция задачи в дне бригады (team_id, scheduled_order, start, end, drive,
additional_stop, anchor, send_status). Это то, что уходит в Slack и хранит
историю; правки в Proposed туда не пишутся, только после Approve.

> Связь статусов: `tasks.status` ведёт задачу по пайплайну; `schedule_runs`
> хранит результат AI; `scheduled_tasks` — финальный одобренный план.

---

## 5. Контракты с n8n

### 5.1 Send to AI (планировщик)
`POST {N8N_PLANNER_WEBHOOK}` (`/webhook/d3dfcd18-…`)
```jsonc
{
  "request_ID": "<uuid>",
  "date": "2025-10-29",
  "source": "requested",
  "Persistent Prompt": "...", "One-time Prompt": "...",
  "tasks": [ /* см. §4.2, scheduled_time приведён к {type,time} или {start,end} */ ],
  "Teams": [ { team_name, team_address, team_latitude, team_longitude, skills:[...] } ],
  "Unavailable teams": [ { team_name } ],
  "Skills": [ ... ],
  "total": 16
}
```
Ответ вебхука — **ack** `{request_ID, ...}`, НЕ расписание. Результат пишется в
`schedule_runs.output_data` по `request_id`.

`Test Send to AI` — тот же payload на тестовый вебхук/флаг (не двигает статусы).

### 5.2 Fetch AI Data → авто-поллинг
После Send to AI приложение само поллит `schedule_runs` по `request_id`
(интервал ~2–3 c, таймаут ~5 мин) до `status='done'`/`'error'`, затем грузит
`output_data` во вкладку Proposed. Ручной ввод Request ID убираем (оставим
скрытый fallback). Альтернатива — Supabase Realtime-подписка (см. Open Questions).

### 5.3 Send tasks (Slack-рассыльщик)
`POST {N8N_SLACK_WEBHOOK}` (`/webhook/67341a95-…`) с одобренным расписанием
(`{ teams: [{ team_name, slack_user_id, tasks:[…] }] }`). Формат финализируем.

---

## 6. Поток статусов (вкладки Tasks)

```
 Requested ──Send to AI──▶ (n8n) ──poll──▶ Proposed ──Approve All──▶ Scheduled ──Send tasks──▶ Slack
    ▲                                          │  Restore                 │ Restore
    └──────────────── правки/возврат ──────────┘◀────────────────────────┘
```

- **Requested** — `tasks.status='requested'`. Фильтры (Date/Search/Project/PM/TaskType),
  группировка `By Project Manager`, блок Generate Schedule (Persistent/One-time prompt),
  `Test Send to AI` / `Send to AI`.
- **Proposed** — отображает `output_data` текущего run. Группировка `By Project`/`By Team`,
  `Explain Yourself` (показывает `comments_ai_1` + `comments_ai_2`), редактируемые
  Travel/Duration/Time, drag, `Approve All`, удаление. **Здесь работает движок §8.**
- **Scheduled** — `scheduled_tasks`. Read-only карточки, `Status`/`Restore`, `Send tasks`.

---

## 7. Экраны и компоненты

| Маршрут | Экран | Ключевые компоненты |
|---|---|---|
| `/login` | Вход | Supabase Auth |
| `/tasks` | Tasks (3 вкладки) | `TabsRequestedProposedScheduled`, `FiltersBar`, `GenerateSchedulePanel`, `TeamGroup`, `TaskCard`, `TaskCardEditable` |
| `/create` | Create Task | `TaskForm` (Project/Other), `TimeTypeToggle` (Exact/Timeframe), `AdditionalStopPicker` (Before/After + Places), `SkillsMultiSelect` |
| `/availability` | Teams Availability | `AvailabilityForm`, `UnavailableList` |
| `/admin` | Admin (4 вкладки) | `ProjectsTable`, `TeamsTable`, `SkillsTable`, `TaskTypesTable`, `SyncFromAirtableButton` |
| `/profile` | Profile | `ProfileForm`, `ChangePasswordForm` |

Общий каркас: тёмный хедер `DALY SCHEDULE — <SECTION>`, лого, бургер-меню
(Create Task, Tasks, Teams Availability, Admin, Profile, Sign out + email/role).

`TaskCard` (Proposed, editable) — поля: Exact time (badge якоря), Travel (input),
Time (start–end), Duration (input), Hours, проект/адрес/скиллы/Additional Stop,
drag-handle, edit/delete. **Все правки идут в черновик Zustand → движок
пересчитывает → ре-рендер; в БД пишется только при Approve.**

---

## 8. ⭐ Scheduling Engine (anchor-aware) — ядро

Чистый модуль `domain/scheduling-engine.ts`. Главная задача — **уважать якоря**.
Текущий Lovable стыкует задачи встык и перетирает якорь (см. `cit7-deep-audit.md`).

### 8.1 Модель дня одной бригады
Вход: home_base(lat,lng), упорядоченный `tasks[]` (scheduled_order), для каждой:
`duration_min`, `anchor (bool)`, `anchor_time?`, `additional_stop?`.
Travel между точками берётся из `mapsClient` (Distance Matrix), кэшируется по
паре координат.

### 8.0 Соответствие старому приложению (3 шага) + фикс
Движок повторяет модель старого `fullTaskRecalculation`, но чинит её баг с якорями:
- **Шаг 1 — базовый travel** между соседними точками (Google Distance Matrix,
  departure_time = end предыдущей задачи → traffic best_guess). Первая задача = 0.
- **Шаг 2 — Additional Stops перезаписывают travel** «пристёгнутой» задачи:
  `after` → крюк `(toStop + stop.duration + fromStop)` уходит в travel СЛЕДУЮЩЕЙ
  задачи; `before` → в travel ТЕКУЩЕЙ. `estimated_duration` задачи не меняется.
- **Шаг 3 — scheduled times**: `start = prev.end + travel`, `end = start + duration`.
  🔴 СТАРОЕ приложение фиксировало только первую задачу → промежуточные якоря
  съезжали. 🟢 НАШ движок: `anchor=true` → `start = anchor_time` намертво, при
  недоезде — `conflict` (см. 8.3). Это и есть исправление.

### 8.2 Правила пересчёта (по порядку)
```
cursor = null  // время, к которому готов выехать к след. задаче
for each task in order:
    driveIn = travel(prevPoint → task.point)              // из Google
    // --- additional stop BEFORE ---
    if stop.when == 'before':
        arriveStop  = cursor + travel(prevPoint → stop)
        leaveStop   = arriveStop + stop.duration
        driveIn     = travel(stop → task.point)
        baseStart   = leaveStop + driveIn
    else:
        baseStart   = (cursor==null ? task-or-anchor start : cursor + driveIn)

    // --- ЯКОРЬ: фиксируем намертво ---
    if task.anchor:
        task.start = task.anchor_time            // НЕ двигаем
        if baseStart > task.anchor_time:         // не успеваем доехать
            mark CONFLICT(task, overlap = baseStart - anchor_time)
        // если baseStart < anchor_time → допускается idle gap (ждём), это норма
    else:
        task.start = baseStart

    task.end = task.start + task.duration

    // --- additional stop AFTER (влияет на выезд к следующей) ---
    if stop.when == 'after':
        cursor = task.end + travel(task.point → stop) + stop.duration
        nextPrevPoint = stop.point
    else:
        cursor = task.end
        nextPrevPoint = task.point

// агрегаты дня
morning_commute = travel(home_base → first.point)   // не рабочее время
end_commute     = travel(last.point → home_base)    // не рабочее время
working_min     = Σ durations + Σ inter-task drives + Σ stop durations
day_category    = ≤480 normal | 481–600 overtime_8_10 | >600 overtime_over_10
```

### 8.3 Инварианты (движок гарантирует)
1. `anchor=true` ⇒ `start == anchor_time` ВСЕГДА (никакой каскад не двигает).
2. Перед якорем допускается простой (idle gap); после — продолжаем от `end`.
3. Если доезд к якорю невозможен вовремя — **не сдвигаем якорь**, а помечаем
   задачу-предшественника/якорь флагом конфликта (UI красным), решает ПМ.
4. Travel — всегда из Google (одна точка истины); `drive_minutes_from_previous`
   в карточке = то, что вернул движок, не из AI.
5. Пересчёт детерминированный и синхронный (кроме асинхронной подгрузки travel,
   которая кэшируется и мемоизируется).

### 8.4 Триггеры пересчёта
Любое из: drag (смена порядка/бригады), правка Duration, правка Travel (ручной
override), добавление/смена Additional Stop, смена exact_time. Пересчитывается
только затронутая бригада (или две при перетаскивании между бригадами).

### 8.5 Ручной override travel
ПМ может вписать Travel вручную. Тогда для этого ребра берётся override вместо
Google (флаг `travel_overridden`), чтобы правка не затёрлась при следующем
пересчёте. Кнопка «пересчитать через Google» сбрасывает override.

---

## 9. Google Maps

- **Places Autocomplete** — поле Additional Stop (Before/After), возвращает
  адрес + lat/lng + (для after) `travel_to`/`travel_from`/`duration`.
- **Distance Matrix** — travel между задачами/стопами/home_base. Кэш по
  `"lat,lng|lat,lng"` (+ грубый time-of-day bucket, если включим трафик).
- Ключ — в env, запросы проксируем при необходимости (квоты/секрет).

---

## 10. Auth и роли

- **Supabase Auth** (email+пароль; смена пароля на `/profile`). Проект Supabase —
  «crews scheduling» (main, PRODUCTION); там же `AI_teams_schedule`, `user_roles`.
- Роль — в таблице `user_roles` (enum `app_role`: **`super_admin` · `pm` · `team_lead`**),
  7 RLS-политик. Гейтинг через RLS + UI.
- Права (предварительно, уточнить точные RLS):
  - `super_admin` — всё (Admin, Sync, все задачи, отправки).
  - `pm` — создание задач, Send to AI, правки Proposed, Approve, Send tasks; видит
    задачи своих проектов.
  - `team_lead` (бригадир) — **заходит в приложение**, видит только СВОЁ
    одобренное расписание (Scheduled, read-only по своей бригаде через RLS).

---

## 11. Структура проекта

```
src/
  app/            # роутер, layout, providers (Query/Auth)
  pages/          # tasks, create, availability, admin, profile, login
  components/     # TaskCard, TeamGroup, FiltersBar, AdditionalStopPicker, ...
  domain/
    scheduling-engine.ts   # §8, чистый + тесты
    types.ts               # доменные типы (Task, TeamDay, ScheduleRun, ...)
    validators.ts          # zod-схемы payload/форм
    formatters.ts          # время/часы/адреса
  services/
    supabaseClient.ts
    n8nClient.ts
    mapsClient.ts
    aiResultPoller.ts
  store/          # zustand: editing draft
  hooks/          # useTasks, useScheduleRun, useTeams, ...
  lib/            # utils, time (America/New_York)
tests/            # unit для scheduling-engine (приоритет)
```

---

## 12. План реализации (фазы)

1. **Каркас**: Vite+TS, Tailwind/shadcn, роутер, Supabase Auth, layout/меню.
2. **Supabase-схема** §4 + сервисы CRUD + синк-обёртка из Airtable.
3. **Scheduling Engine** §8 + юнит-тесты (якоря, доп.остановки, overtime, конфликты) — **до UI**.
4. **Create Task** + Requested (список, фильтры, Generate Schedule).
5. **n8n-клиент** (Send to AI) + **авто-поллинг** + Proposed (рендер output_data).
6. **Редактор Proposed**: drag, правки, движок, Explain Yourself, Approve All.
7. **Scheduled** + Send tasks (Slack) + Status/Restore.
8. **Admin / Teams Availability / Profile**.
9. Роли/RLS, полировка, деплой.

---

## 13. Open Questions (согласовать)

**Решено:**
- ✅ Роли: `super_admin · pm · team_lead` (таблица `user_roles`, Supabase «crews
  scheduling»). `team_lead` (бригадир) заходит в приложение и видит своё расписание.
- ✅ Auth: Supabase email+пароль.
- ✅ Travel: Google Maps (фронт) — источник истины.
- ✅ Fetch AI: авто-поллинг.
- ✅ n8n параллельно НЕ чиним сейчас (баги известны — `cit7-deep-audit.md`).

**Открыто:**
1. **Timeframe-задачи** — ⚠️ ОБСУДИТЬ С КЛИЕНТОМ: как должно учитываться окно
   `{start,end}` (сейчас n8n его игнорирует). Пока не реализуем спец-логику.
2. **«Доп. обязательная задача, подсветить перед клиентом»** — уточнить, что
   именно имелось в виду (поле задачи? отдельная сущность? правило отображения).
   Источник — устная фраза, смысл не зафиксирован.
3. **Slack-отправка**: финальный формат payload `Send tasks`; маппинг
   `team → slack_user_id` (в `teams`?).
4. **Создание пользователей/паролей**: как заводятся аккаунты и роли (вручную в
   Supabase? через Admin-экран?) — юзер уточнит.
5. **Мульти-дата**: один день за раз или несколько (n8n сейчас валит всё в один).
6. **Хостинг** нового фронта (Vercel/Netlify/Render?) и где env-ключи (Supabase,
   Google Maps, n8n webhooks).
```
