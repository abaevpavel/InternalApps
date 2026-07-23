# Task Planner — сводная документация

> **Сведено из 9 доков 2026-07-23.** Источники: `SPEC.md`, `AUDIT.md`, `MIGRATION.md`,
> `AI-MODULES.md`, `analysis.md`, `cit7-deep-audit.md`, `cit7-prod-analysis.md`,
> `cit7-inserter-prompt-flexible.md`, `n8n-skill-level-changes.md`.
>
> **Статус системы:** n8n-воркфлоу `cit7Gah53xPLLbdy` «Task Planner» **работает в проде**
> (basementremodeling.app.n8n.cloud) и рассылает дневное расписание бригадам в Slack.
> Раздел про n8n — **живой референс**. Старый отдельный фронт «Daly Schedule» уже вплавлён
> в портал (`apps/portal` / `apps/task-planner`); его спека бизнес-правил актуальна,
> а аудит фронта и план миграции — преимущественно **исторический контекст**.
>
> **Легенда:** 🟢 ЖИВОЕ/актуальное · 🕘 ИСТОРИЯ (устарело после вплавления в портал) ·
> ❓ открытый вопрос к клиенту · 🔴 критично.
>
> **Канонические артефакты (полные листинги — рядом в `docs/`, этот док их конспектирует):**
> `n8n-matcher.applied.js` (JS-матчер, §5.2), `n8n-other-tasks-agent.prompt.txt` (промпт
> inserter'а, §5.3), `t3d-planner.patched.json` (пропатченный экспорт t3d-воркфлоу).

---

## Оглавление

1. [Обзор подсистемы](#1-обзор-подсистемы)
2. [Бизнес-правила и доменная модель](#2-бизнес-правила-и-доменная-модель)
3. [Архитектура n8n-воркфлоу cit7](#3-архитектура-n8n-воркфлоу-cit7)
4. [Поузловой референс для дебага](#4-поузловой-референс-для-дебага)
5. [Применённые правки в прод](#5-применённые-правки-в-прод)
6. [Известные баги, риски, надёжность](#6-известные-баги-риски-надёжность)
7. [Slack-рассыльщик](#7-slack-рассыльщик)
8. [Исторический контекст (фронт, миграция, портал)](#8-исторический-контекст)
9. [Открытые вопросы к клиенту](#9-открытые-вопросы-к-клиенту)
10. [Хронология и эволюция](#10-хронология-и-эволюция)

---

## 1. Обзор подсистемы

**Task Planner** (он же исторически «Daly Schedule») — система планирования **дневных
расписаний бригад** компании basementremodeling.com (ремонт подвалов, регион
**DC/MD/VA**). Заменила старый фронт на Lovable, чей пересчёт времён ломал якоря.

**Рабочий цикл:**
```
[Create Task] → Requested → (Send to AI → n8n) → Proposed → (правки + Approve) → Scheduled → (Send → Slack)
```
Project manager собирает задачи на день → отправляет AI-планировщику (n8n) → получает
черновое расписание по бригадам → правит вручную → одобряет → рассылает бригадам в Slack.

**Две части системы:**

| Часть | Что | Статус |
|---|---|---|
| Фронт | SPA (React 18 + Vite + TS, TanStack Query, Zustand, Supabase, Google Maps, Tailwind/shadcn, dnd-kit). Движок пересчёта времён (`scheduling-engine`) — чистый, тестируемый. | 🟢 вплавлён в портал (`apps/task-planner`) |
| Бэкенд-планировщик | n8n-воркфлоу `cit7Gah53xPLLbdy` (LLM-агенты) | 🟢 ПРОД, active |
| Slack-рассыльщик | n8n-воркфлоу `aa6XaAQ6xuLEZRcz` | по докам Disabled; отправка в Slack — целевой финальный шаг |

**Инфраструктура:**

| Слой | Значение |
|---|---|
| Supabase | проект «crews scheduling» `dhtewaqfcsejdllwhgtl` (`https://dhtewaqfcsejdllwhgtl.supabase.co`). Auth email+пароль. Фронт = anon-ключ + user-JWT |
| n8n прод (канон) | `basementremodeling.app.n8n.cloud`, планировщик-webhook `/webhook/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27` |
| n8n временный | `t3d-projects.app.n8n.cloud` (использовался, пока не хватало кредитов basement), test-webhook `/webhook-test/d3dfcd18…` |
| Справочники | синкаются из **Airtable** через **Supabase Edge Functions** (НЕ через n8n) |
| Перспектива | переезд n8n на self-hosted VPS |

> 🔴 **Единая Supabase.** n8n обязан писать результат в **ту же** базу
> (`dhtewaqfcsejdllwhgtl`, таблица `AI_teams_schedule`), которую читает фронт — иначе кнопка
> «Подтянуть результат AI» ничего не найдёт. Проверять кред в ноде `Update a row`.

---

## 2. Бизнес-правила и доменная модель

*(Источник: SPEC.md — актуально как источник бизнес-правил.)*

### 2.1 Модель данных

**`tasks`** (ядро, фронт-Supabase): `id`, `status` (`requested|proposed|scheduled|archived`),
`task_type`, `project_id?`, `description`, `scheduled_date`, `scheduled_time` (jsonb, §2.4),
`estimated_duration` (**в БД часы; в домене минуты**), `address/lat/lng`, `project_manager`,
`team_id?` (null = unassigned), `priority` (5=normal), `skill_requirements[]`,
`schedule_prompt?`, `additional_stop?` (jsonb), `stop_number?`, `travel_time?`,
`request_task_id?` (proposed-копия → исходная задача — 🕘 только dev), `title?`, аудит-поля.

**`AI_teams_schedule`** (история прогонов планировщика): `request_ID` (text),
`input_tasks` (jsonb — снимок входа), `output_data` (jsonb —
`{schedule:[{date,tasks…}], commentsAI-1, commentsAI-2}`), `created_at`. Хранение входа И
выхода позволяет сверять расхождения и **прогонять заново**. Готовность результата =
появилось `output_data.schedule`.

**Справочники** (синк из Airtable): `projects`, `teams` (+скиллы через текст в
`skills.description`), `skills`, `task_types`, `team_availability`, `user_roles` (enum `app_role`).

### 2.2 Жизненный цикл задачи (статусы)

| Статус | Смысл | 🟢 Прод-поведение |
|---|---|---|
| **Requested** | эталонный набор задач дня | Create Task; Send to AI (переводит сами задачи в proposed) |
| **Proposed** | расписание от ИИ: правки, drag, движок пересчёта | «Подтянуть результат AI»; правки/drag; Approve All → Scheduled |
| **Scheduled** | одобренный план | Send to Slack; read-only; хранение ~1 мес (❓ срок уточнить) |
| **Archived** | ⚠️ значение enum есть, но **логики нет** нигде в коде | ❓ уточнить у клиента — нужен ли архив |

> 🕘 **Dev-каркас (снят/снимается в проде):** «↺ Сбросить тестовый набор», Proposed как
> копии (`request_task_id`→оригинал), «🗑 Удалить все». В проде — **плавный переход статусов
> одной строки** без дублирования.

### 2.3 Round-trip целостность 🔴 (ключевой принцип)

ЛЛМ/пайплайн обязан **пронести ВСЮ входную информацию задачи и вернуть её на выходе без
потерь**, лишь **добавив расписание** (время, бригада, порядок, travel). Связь строго по
**`task_id`**, никаких «оригинал → копия».
- Каждая задача на выходе = все входные поля (id, description, project, `priority`,
  `skill_requirements`, `scheduled_time`, `additional_stop`, …) **+ поля расписания**.
  Пропало поле — это баг.
- Следствие для n8n: **carry-through** должен быть гарантирован (см. §5 — сейчас закрыт
  Code-нодами, которые берут поля из оригинала).
- Проверка: каждое входное `task_id` есть в выходе ровно один раз (или в `unscheduled` с причиной).

### 2.4 Якоря (exact time)

- Задача с `time_type=exact` + `exact_time` = **якорь** (жёсткое время старта).
- **Формат для ИИ:** `{ "type": "exact", "time": "HH:MM" }` (НЕ `start`).
  Timeframe — `{ "type": "timeframe", "start", "end" }`.
- **Невалидно:** exact без времени — запрещено (Create Task не сохраняет).
- **Инварианты движка:** `anchor=true` ⇒ `start == anchor_time` всегда; перед якорем допустим
  простой; недоезд → **не двигаем якорь**, помечаем `conflict` (UI красным).
- Первый таск дня: ранний anchor (<07:00) → первым; иначе ближайший к home base.

### 2.5 Timeframe (окно) ❓

Окно `{start,end}`, альтернатива exact. **Пока НЕ используется.** Поле сохраняем; применять
ли — уточнить у клиента.

### 2.6 Скиллы и уровни

- Связь скилл↔команда — текст в `skills.description` («Available teams: rec…»), ключ
  `team.airtable_id`.
- **Уровень** = суффикс `"- N"`; **level 1 = высший приоритет** (меньше = лучше).
- Фронт шлёт `team.skills` как `[{name, level}]`. Тег­гер (LLM) навешивает скиллы из описания
  (голые имена); матчинг по имени, ранжирование по уровню (`optional_team_level`).

### 2.7 Travel и пробки ❓ (модель к согласованию)

Реальное время в пути зависит от пробок; надёжно считать это в LLM нельзя. Принятая модель:
1. **Планировщик (n8n)** считает travel **БЕЗ пробок** — грубая стабильная оценка (для порядка
   и выполнимости). Сейчас агенты оценивают драйв «на глаз», без матрицы расстояний.
2. **Фронт (Proposed)** даёт реальный travel отдельным шагом — кнопка **«Пересчитать travel
   (Google)»**: Distance Matrix с `departure_time` + `traffic_model=best_guess`. Кэш по
   `(откуда, куда, time-bucket)`.

**Общие правила travel (зафиксированы):**
- Travel **входит** в рабочее время.
- Доезд от дома к первой задаче (`morning_commute`) — **не** рабочее время (`drive=0` у первой).
- Доезд домой после последней (`end_of_day_commute`) — **не** рабочее время.
- У каждой бригады есть **home base** — участвует в подсчётах.
- Источник истины — Google; перетирает оценку планировщика (кроме ручного override).

### 2.8 Additional stop (доп. остановка) — обязательна, если задана

Поле задачи `additional_stop = {when:'before'|'after', address, lat, lng, duration_min,
travel_to_min?, travel_from_min?}`. Не отдельная задача, а свойство задачи (бейдж
«+stop before/after (Xm)»). Если задана — маршрут идёт ЧЕРЕЗ неё; `estimated_duration` задачи
не меняется.

**✅ Модель учёта — B («сплит»), ВЫБРАНА** (движок перевести на неё — TODO):
- `drive_minutes_from_previous` соседней задачи = `toStop + fromStop` (реальный драйв через
  крюк, заменяет прямой A→B; берётся из Google).
- Стоянка `duration_min` — **отдельный видимый пункт** между задачами, НЕ внутри travel.
- `total_working = Σ длительности задач + Σ драйвы + Σ стоянки`, каждое ровно раз.
- ⚠️ Сейчас движок реализует модель **A (бандл)** — стоянка свёрнута в travel; перевести на B.

### 2.9 Рабочий день / overtime

`working_min = Σ длительностей + Σ inter-task drives + Σ длительностей остановок`.
День: **≤480 `normal`** | **481–600 `overtime_8_to_10`** | **>600 `overtime_over_10`** (>600
запрещено — hard limit).

> ❓ 🕗 **Строгих рабочих часов НЕТ.** Планировщик не знает про «рабочий день с X до Y»: день
> начинается со времени первой задачи, единственный лимит — overtime. Возможны вечерние/ночные
> смены (напр. 12:00→21:15 или 18:10→23:25). Нужны ли строгие старт/конец/лимиты — к клиенту.

### 2.10 Auth, роли

Supabase Auth (email+пароль). Роли — `user_roles`, enum `app_role`:
`super_admin | pm | team_lead`, RLS.
- **super_admin** — полный доступ: **Pavel A** (`pavel.a@achgroupllc.com`, владелец) и
  **t3d developer** (`dev@todor3d.com`).
- **team_lead = ПМ** (бригадиры по факту и есть project manager'ы). Отдельное урезанное вью.
  Список (все `@achgroupllc.com`): Javier Cruz-Lopez, Ezequiel Perez Garcia, Jeovanni Corcio,
  Oscar Herrera, Luis Milian, Alfredo Lopez, Wilfredo Lopez, Jorge Zeballos, Gheorghe Caminschi.
- ❓ Отдельная роль `pm` в enum есть — используется ли, или всё через `team_lead`.

> 🔴 **RLS:** таблица `tasks` доступна только **authenticated**. Правки задач — только из
> браузера под юзером (serverless-ключом нельзя).

---

## 3. Архитектура n8n-воркфлоу cit7

🟢 **ЖИВОЕ.** Воркфлоу `cit7Gah53xPLLbdy` «Task Planner», active, прод на basement.

### 3.1 Асинхронная модель: ответ ≠ результат

Сразу после приёма поток **раздваивается** (`Edit Fields2` → два выхода): одна ветка мгновенно
отвечает фронту ack, вторая асинхронно строит расписание и пишет его **только в Supabase**.

```
Webhook
  └─ Edit Fields2 ─┬─→ Edit Fields ─→ Respond to Webhook              ← МГНОВЕННЫЙ ACK
                   │      (отдаёт только {request_ID, Persistent/One-time Prompt})
                   │
                   └─→ Create a row1 (Supabase insert input_body+request_ID)
                        └─→ filter unavailable
                             └─→ filter unassigned tasks
                                  └─→ Edit Fields1
                                       └─→ Unassigned Tasks with skills [AI#1 тег­гер]
                                            └─→ Parse Skills (Code)      ← см. §5
                                                 └─→ Fields
                                                      └─→ unassigned tasks with optional teams [МАТЧЕР]
                                                           └─→ Assigned tasks Agent [AI#2 route builder]
                                                                └─→ Parse Route (Code)
                                                                     └─→ Other tasks Agent [AI#3 inserter]
                                                                          └─→ Parse Insert (Code)
                                                                               └─→ Merge comments (Code)
                                                                                    └─→ Edit Fields3
                                                                                         └─→ Update a row (Supabase) ← РЕАЛЬНЫЙ РЕЗУЛЬТАТ
```

**Инвентарь:** 16 модулей основного потока + сабноды агентов. Готовность результата =
`output_data.schedule` появилось в строке `AI_teams_schedule` по `request_ID`.

### 3.2 Входной payload (body вебхука)

```
{
  request_ID,
  "Persistent Prompt",   // постоянный frontend-оверрайд (🕘 позже убраны из фронта, см. §5)
  "One-time Prompt",     // разовый frontend-оверрайд
  tasks: [ {
    id, description, estimated_duration (часы), priority,
    scheduled_date, scheduled_time:{ type:"exact"|"timeframe", start, end },
    project:{ project_id, project_name, project_address, project_latitude, project_longitude },
    team: {…}|null        // null/пусто = задача НЕ назначена
  } ],
  Teams: [ { team_name, team_address, team_latitude, team_longitude, skills:[{name,level}] } ],
  "Unavailable teams": [ { team_name } ],
  Skills: [ … ]           // библиотека допустимых скиллов
  // total, source, date — также встречаются во входе
}
```

> ⚠️ **Расхождение форматов между нодами (латентно):** промпты агентов читают
> `scheduled_time.time`, а вход даёт `{type, start, end}` (поля `start/end`, нет `time`).
> `filter unassigned tasks` для веса сортировки читает `.start`. Пока не выстреливало, т.к.
> в happy-path прогонах не было якорей. Целевой фикс — нода-нормализатор входа к
> `{type, time}` + `estimated_duration_minutes` (см. §6 S1/C4).

### 3.3 Где ИИ / недетерминизм

- **3 LLM-агента недетерминированы.** Модели менялись во времени (см. §10); на последнем срезе
  (AI-MODULES, 2026-06-24/25) — **все 3 на gpt-5**, который игнорирует `temperature=0` → полной
  воспроизводимости нет.
- **Матчер — единственный полностью детерминированный** LLM-соседний модуль (чистый JS).
- **Драйв без матрицы** — оба маршрутных агента оценивают ETA «из головы» → плавающие времена.
  Реальный travel считает фронт (Google), §2.7.
- **Round-trip:** через тег­гер (AI#1) проходят ТОЛЬКО unassigned-задачи (там был риск потери
  полей — закрыт Code-нодой). Assigned-задачи `Assigned tasks Agent` берёт напрямую из
  `filter unassigned tasks` → их поля целы.

### 3.4 Симптом → где смотреть (быстрый дебаг)

| Симптом | Смотреть |
|---|---|
| `Model output doesn't fit required format` | 🕘 было — строгий Structured Output Parser; сейчас парсеры сняты (§5), падений быть не должно |
| Все задачи ушли в unscheduled | **МАТЧЕР** (`optional_team` пуст?) → скиллы команд, формат `{name,level}` |
| Пропали `priority`/`skills` у задач | **AI#1 тег­гер** + `Parse Skills` (round-trip) |
| Якорь «съехал» / ночная смена | вход: `scheduled_time` формат; **AI#2** промпт (anchor handling) |
| `comments_ai_1` пустой | `Merge comments` — имя ноды в `$items('Parse Route')` / `Assigned tasks Agent` |
| Результат не появился в приложении | `Update a row` — пишет ли в ту же Supabase (`AI_teams_schedule`) |

---

## 4. Поузловой референс для дебага

🟢 **ЖИВОЕ.** По каждой ноде: роль, вход, промпт/логика, риски. Сведено из AI-MODULES +
analysis + cit7-*.

### 4.1 Webhook → Edit Fields2 (вход, не AI)
Принимает POST фронта. `Edit Fields2` раскладывает: `Teams = body.Teams`,
`UnavailableTeams = body['Unavailable teams']`, `tasks = body.tasks`,
`request_ID = body.request_ID`. Ветка ACK: `Edit Fields → Respond to Webhook` (отвечает сразу,
НЕ расписанием). **Дебаг:** пришли ли `tasks/Teams/Skills`, формат `scheduled_time`.

### 4.2 Create a row1 (Supabase insert)
Создаёт строку в `AI_teams_schedule` с `request_ID` + `input_tasks`/`input_body` (снимок входа).
`onError: continueRegularOutput`. **Дебаг:** нет строки → кнопка «Подтянуть» ничего не найдёт.

### 4.3 filter unavailable (Code, детерминирован)
`Teams` минус `UnavailableTeams` по нормализованному имени (NFKC). Выдаёт `Teams` (доступные) +
`ExcludedTeams`. **Дебаг:** нужные бригады не отфильтровались из-за расхождения имён?

### 4.4 filter unassigned tasks (Code, детерминирован)
Делит задачи на `assigned` (есть `team`) и `unassigned`; группирует assigned по бригадам;
считает часы; сортирует по «весу времени» (exact=0, timeframe=1, none=3), затем priority, затем
длительность. **Ключ round-trip:** `assigned` идут дальше В ОБХОД тег­гера (поля целы).
**Дебаг:** счётчики `counts {assigned, unassigned}`; если задача с командой попала в unassigned —
смотреть `hasTeam()`.
> 🟡 `assigned_by_team` вычисляется, но не используется (route builder читает сырой `.assigned`) —
> мёртвый код.

### 4.5 🤖 AI#1 — `Unassigned Tasks with skills` (ТЕГ­ГЕР)
- **Роль:** каждой **unassigned**-задаче проставить скиллы из её описания (для матчинга).
- **Вход:** `Edit Fields1` → `UNASSIGNED_TASKS_JSON` + `SKILLS_LIBRARY_JSON`.
- **Промпт (ключевое):** назначь скиллы ТОЛЬКО из SKILLS; не выдумывай; **сохрани исходные поля
  задачи**, добавь `skills:[{name}]`; у каждой задачи непустой skills.
- **Модель:** менялась (gpt-4 → gpt-4o → gpt-5, см. §10).
- ✅ **Structured Output Parser снят (2026-06-25):** «Require Specific Output Format» = OFF; агент
  отдаёт обычный текст — минимальный JSON `[{id, skills:[…]}]`. Парсинг и целостность — в Code-ноде
  `Parse Skills`. **Дебаг:** Output агента = строка JSON; раскладку смотреть в `Parse Skills`.

### 4.6 `Parse Skills` (Code — заменила Structured Output Parser1) ✅
Берёт текст агента (`$json.output`), защитно парсит (снимает ```-обёртки, `JSON.parse` с
try/catch), нормализует skills (string→`{name}`), **прицепляет скиллы к ОРИГИНАЛЬНЫМ
unassigned-задачам** из `filter unassigned tasks` по `id`. Выход всегда:
`{ output: { tasks_with_skills:[…], meta:{notes} } }`. Round-trip гарантирован кодом (поля из
оригинала, не из вывода LLM); при отсутствии скиллов — сигнал в `meta.notes`, нода не падает.

### 4.7 Fields (мост тег­гер → матчер, Set)
`tasks_with_skills = $json.output.tasks_with_skills`; `available_teams = filter unavailable.Teams`;
`assigned tasks`; `frontend overrides` (склейка Persistent + One-time Prompt).

### 4.8 ⚙️ МАТЧЕР — `unassigned tasks with optional teams` (Code, ДЕТЕРМИНИРОВАН)
- **Роль:** для каждой unassigned-задачи найти подходящие бригады по скиллам, **с учётом уровня**
  (level 1 = высший); «лучшие первыми».
- **Логика:** нормализует имена скиллов (срезает «- N»); строит `Map(имя→мин.уровень)` по командам;
  задача подходит команде, если та умеет ВСЕ требуемые скиллы (`required.every(...)`); добавляет
  `optional_team` с `optional_team_level`; сортирует по уровню.
- **Выход:** `tasks_with_optional_teams` + `teams_with_optional_tasks`.
- ✅ **Версия с уровнями (Change 2) применена** (basement + t3d). Старый матчер (`Set` строк) ломался
  на объектах `{name,level}` → «[object object]» → ноль матчей.
- **Дебаг:** у задач непустой `optional_team`? стоит `optional_team_level`? Пусто → расхождение
  имён скиллов задача↔команда.
- 🟠 **Риск S2:** `if (!required.length) return false` + строгий супермножественный матч → бригада
  без скиллов (в прогоне — Gheorghe Caminschi, `skills:[]`) не получит ни одной задачи; задача без
  подходящей бригады молча уходит в unscheduled. Рекомендация: фолбэк `needs_review`, заполнить
  скиллы бригад.
- 🟡 Опечатка `optional_teamlatitude` (без `_`) — латентно (гео пока не читается агентами).

### 4.9 🤖 AI#2 — `Assigned tasks Agent` (ROUTE BUILDER / маршруты)
- **Роль:** построить дневные маршруты/времена для **уже назначенных** задач (по бригадам), с
  учётом якорей и реалистичного драйва.
- **Вход:** напрямую `$('filter unassigned tasks').item.json.assigned` (поля целы) +
  `frontend overrides`.
- **Промпт (ключевое):** anchors immutable (`scheduled_time.type=='exact'` → `start == time`,
  не перекрывается); первый таск по якорю (<07:00) / ближайшему к дому; драйв реалистичный
  DC/MD/VA **без матрицы**; `morning/end_of_day_commute` — не рабочее время, межзадачные переезды —
  рабочее; день ≤480 / 481–600 / >600; каждый таск ровно раз под своей бригадой, ID/длительности
  не меняются; жёсткий self-validation gate перед выводом.
- **Выход:** `schedule:[TeamDay{team_id,…,tasks:[{scheduled_order, task_id, project_*, anchor,
  anchor_time, start_time, end_time, duration_minutes, drive_minutes_from_previous}], summary}],
  comments:{anchor_conflicts_resolved[], first_task_rationale, overtime_notes, …}`.
  Парсинг — Code-нода `Parse Route`.
- **Недетерминизм:** gpt-5 (temp≠0), драйв «на глаз» → времена плавают.
- **Дебаг:** якорь `start_time == anchor_time`? `anchor_conflicts_resolved` непустой при якорях?

### 4.10 🤖 AI#3 — `Other tasks Agent` (INSERTER / вставка unassigned)
- **Роль:** вставить **unassigned**-задачи в расписание из AI#2, выбрав команду из `optional_team`
  (с учётом `optional_team_level` — Change 3), не ломая якоря.
- ⚠️ **Имя ноды разное по инстансам:** basement = **`Other tasks Agent1`**, t3d = **`Other tasks
  Agent`**.
- **Вход:** `schedule` от AI#2 (`$json.output.schedule`) + `tasks_with_optional_teams` от матчера +
  `frontend overrides`.
- **Промпт (ключевое):** каждый unassigned с ≥1 eligible-командой ДОЛЖЕН быть размещён; нельзя
  двигать якоря/создавать перекрытия; **SKILL-LEVEL PRIORITY** (меньший `optional_team_level`
  лучше); scoring-формула; иначе → unscheduled с причиной.
- ✅ **Промпт с уровнями (Change 3) применён** (basement + t3d). Парсинг — Code-нода `Parse Insert`.
- **Недетерминизм:** gpt-5; выбор команды = формула score + драйв «на глаз».
- **Дебаг:** `comments.unscheduled` (почему не вставил); у вставленных — правильная ли команда по
  уровню.
- ⚠️ **Мандат reschedule — незакрытый вопрос (S6):** есть два варианта промпта — строгий
  **no-reschedule** (route builder фиксирует маршрут, inserter только вставляет в зазоры) и
  **гибкий** (inserter может двигать/переназначать non-anchor задачи). Гибкий вариант противоречит
  route builder'у, снижает предсказуемость. Полный текст гибкого промпта и scoring — см. §5.4.

### 4.11 Merge comments / Code in JavaScript (Code, детерминирован)
Собирает `commentsAI-1` (из route builder) и `commentsAI-2` (из inserter) в `output`, удаляет
`output.comments`, возвращает skills обратно в schedule. После снятия парсеров переименована в
`Merge comments`, тянет `$items('Parse Route')`.
> 🔴 **Историческая точка бага (C1):** код читал `$items('Assigned tasks Agent', …)`, а нода
> называлась `Assigned tasks Agent1` → `commentsAI-1` терялся молча. Фикс: точное совпадение имени.
> По n8n-skill-level-changes баг помечен закрытым; после ввода `Parse Route` merge тянет её. При
> дебаге пустого `commentsAI-1` — проверять имя ноды в коде.

### 4.12 Edit Fields3 → Update a row (Supabase update)
`Edit Fields3` кладёт `$json.output` (финальное расписание) в поле; `Update a row` пишет его в
`AI_teams_schedule.output_data` по `request_ID`.
> 🔴 Кред Supabase должен указывать на **ту же базу**, что читает фронт (`dhtewaqfcsejdllwhgtl`).
> **Дебаг:** появилось ли `output_data.schedule` в строке прогона.

### 4.13 Чек-лист «прогон прошёл корректно»
- [ ] Тег­гер не упал; у unassigned появились `skills`.
- [ ] Матчер: у задач непустой `optional_team` + `optional_team_level`.
- [ ] Каждое входное `task_id` есть в выходе ровно раз (или в `unscheduled` с причиной).
- [ ] Якоря: `start_time == anchor_time`, нет перекрытий.
- [ ] Поля `priority`/`skills`/прочее не потерялись (round-trip).
- [ ] `output_data.schedule` записан в `AI_teams_schedule` (та же Supabase, что у фронта).

---

## 5. Применённые правки в прод

### 5.1 Перевод всех 3 агентов на Code-парсинг ✅ (2026-06-25) 🟢

Structured Output Parser убраны у **всех трёх** агентов; после каждого — Code-нода:
`Unassigned Tasks with skills → Parse Skills`, `Assigned tasks Agent → Parse Route`,
`Other tasks Agent → Parse Insert`. Merge-нода → `Merge comments`, тянет `$items('Parse Route')`.
Падений `Model output doesn't fit required format` больше нет (валидатора нет; целостность — в коде).
**Подтверждено полным прогоном** (req `f37c604a`, 2026-06-25): 16/16 покрытие, якоря 09/11/12 на
месте, 0 перекрытий, 0 unscheduled, 3 unassigned размещены инсертером по eligibility.

### 5.2 Change 2 — скилл-матчинг с учётом уровня ✅ (2026-06-23) 🟢

**Применено на basement (прод) через n8n MCP и проверено diff'ом; t3d — пропатченный экспорт
`docs/t3d-planner.patched.json`.**

Причина: фронт шлёт `team.skills` как `[{name, level}]`, а старый матчер ждал массив строк →
`normSkillName(объект) = "[object object]"` → ноль матчей → всё в unscheduled.

Суть кода (`docs/n8n-matcher.applied.js`): `Set` → `Map(имя→лучший уровень)`; понимает
`{name, level}` И старые строки `"Name - 2"`; в каждый `optional_team` добавлен
`optional_team_level` (эффективный = худший/макс. номер среди требуемых скиллов); список команд
отсортирован «уровень 1 вперёд, null в конец, затем по имени». Функции: `parseTeamSkill`,
`canTeamDoTask` (супермножество), `teamLevelForTask`, `findEligibleTeams`, `findEligibleTasks`.

### 5.3 Change 3 — промпт inserter'а с уровнями ✅ (2026-06-23) 🟢

Нода `Other tasks Agent1` (basement) / `Other tasks Agent` (t3d). Итоговый промпт —
`docs/n8n-other-tasks-agent.prompt.txt`. Три вставки:

**3.1 INPUT** — к строке про `optional_team`:
```
optional_team: [{ "optional_team_name", "optional_team_address", "optional_team_level" }, ...]
optional_team_level: skill level of that team for THIS task (1 = most qualified, lower is better; null = unknown).
The optional_team array is PRE-SORTED best-first by optional_team_level.
```
**3.2 ASSIGNMENT RULES** — новое правило:
```
SKILL-LEVEL PRIORITY:
Among eligible teams for a task, prefer the one with the LOWEST optional_team_level (1 = highest skill).
Strong tiebreaker: apply AFTER anchors/feasibility/overtime limits, but it OUTWEIGHS
small drive-time differences (<= 15 min). Treat null level as the worst.
```
**3.3 SCORING & CHOICE** — новая формула:
```
score = added_drive_minutes
      + 25 * (optional_team_level_or_3 - 1)
      + 30 * overtime_hours_after_insertion
      + 200 * is_over_10h
      - 2 * priority
where optional_team_level_or_3 = optional_team_level if present else 3.
Tie-breakers: (1) lower optional_team_level, (2) no-overtime, (3) lower added_drive,
(4) fewer total tasks, (5) shorter last_stop->T distance.
```

**Change 1** (тег­гер: gpt-4o + relaxed Parser1 `required` только `id`+`skills`) — было сделано до
Change 2/3, затем перекрыто снятием парсеров (§5.1).

### 5.4 Гибкий промпт inserter'а (референс, cit7-inserter-prompt-flexible.md)

Готовый **гибкий** вариант промпта `Other tasks Agent1` из линии `p3uL`/`lvUAx`, адаптированный
под cit7 (может двигать non-anchor задачи, чтобы вставить новые). Отличия от строгого варианта:
- **PRIME DIRECTIVE:** каждый unassigned с ≥1 eligible-командой должен быть назначен; ради этого
  можно reschedule/reassign существующие **non-anchor** задачи (дата/длительность неизменны),
  но **никогда не двигать якоря** и не создавать перекрытий.
- Правки относительно оригинала: убрана мёртвая ветка `eligible_team_ids` (апстрим отдаёт только
  `optional_team`); фикс границы overtime `600 min →` → `> 600 min →`.
- Ссылки уже совпадают с cit7: `$json.output.schedule`,
  `$('unassigned tasks with optional teams').item.json.tasks_with_optional_teams`,
  `$('Fields').item.json['frontend overrides']`.
- OVERTIME: ≤480 normal / 481–600 allowed / >600 disallow → другая команда → иначе unscheduled.
- UNSCHEDULED JUSTIFICATION — обязательные ключи: `task_id`, `reason`
  (`anchor_time_unreachable|no_eligible_team|overtime_hard_limit|infeasible_between_anchors|...`),
  `anchor_time`, `eligible_teams_tried`, `best_feasible_team`, `earliest_arrival_possible`,
  `minutes_short`, `notes`.
- ⚠️ Модель НЕ трогать (остаётся claude-opus-4-5 в той версии); проверить Parser3 на допустимость
  обновлённых `start_time/end_time/scheduled_order` (если парсер ещё есть — после §5.1 снят).

> **Незакрытый выбор (S6):** строгий no-reschedule vs гибкий. Прод-разбор (cit7-prod-analysis)
> фиксирует inserter как **NO RESCHEDULING** (opus-4-5), гибкий промпт — альтернатива. Требует
> решения по политике.

### 5.5 Убрано из фронта
Поля Persistent/One-time Prompt убраны из фронта (2026-06-23), хотя во входном контракте вебхука
поля ещё фигурируют и агенты читают `frontend overrides`.

---

## 6. Известные баги, риски, надёжность

🟢 Актуальный технический долг планировщика (сведено из cit7-deep-audit + cit7-prod-analysis + SPEC §7).

### 6.1 Критические (до прода)

| # | Проблема | Фикс | Статус |
|---|---|---|---|
| C1 | `Code in JavaScript` читал `$items('Assigned tasks Agent')` при ноде `Assigned tasks Agent1` → `commentsAI-1` терялся молча | точное имя ноды | помечен закрытым (skill-level doc); после `Parse Route` merge тянет её |
| C2 | Нет ретраев на 3 агентах → сбой LLM роняет весь прогон после записи input | `retryOnFail=true`, `maxTries 3–5`, `waitBetween≈3000` (в тест-версии `lvUAx` было) | ⏳ рекомендация |
| C3 | Асинхронная запись без статуса → «вечный поллинг» | поле `status` (`processing/done/error`) + error-ветка | ⏳ |
| C4 | Рассинхрон `scheduled_time`: промпт ждёт `.time`, вход даёт `{start,end}` → якоря сломаются на реальных данных | нода-нормализатор входа `{type, time}` | ⏳ (не выстрелило т.к. happy-path без якорей) |

### 6.2 Серьёзные

- **S1.** Длительность часы vs минуты: агенты/матчер отдают `estimated_duration` часами строкой
  (`"4"`), inserter ждёт `estimated_duration_minutes (int)`. В прогоне угадал («4»→240) — везение.
  Фикс: считать `estimated_duration_minutes = round(estimated_duration*60)` в коде.
- **S2.** Бригады без скиллов + строгий супермножественный матч (см. §4.8). Фолбэк `needs_review`,
  заполнить скиллы бригад.
- **S3.** Мульти-дата сваливается в один день: route builder игнорирует `scheduled_date`
  (в прогоне задачи разных дат, `body.date=null`, финалу проставился `date` первой задачи).
  ❓ Подтвердить: один день (фильтровать вход по дате) или несколько (группировать до route builder).
- **S4.** Webhook открыт (`allowedOrigins:"*"`, без токена/подписи) → DoS/абьюз + расход
  LLM-токенов. Фикс: Header Auth / подпись, сузить CORS.
- **S5.** Нет валидации входа (пустой `tasks`/`Teams`, битый JSON). Фикс: ранняя нода-валидатор →
  `status=error` при провале.
- **S6.** Два агента с противоречивыми мандатами (route builder «не двигать» vs гибкий inserter
  «можно двигать»). Выбрать политику или объединить в один проход.

### 6.3 Недетерминизм и мелочи

- **D1.** `temperature≠0` хотя промпты обещают детерминизм; на gpt-5 temp=0 всё равно недоступен.
- **D2.** Драйв без матрицы (сердце планирования) — кандидат на реальный ETA-провайдер
  (Google Distance Matrix / OSRM) отдельным детерминированным шагом.
- **D3.** `assigned_by_team` — мёртвый код.
- **D4.** Опечатка `optional_teamlatitude` (латентно).
- **D5.** `teamMeta` непоследователен (`address` vs `team_address`).
- **D6.** Parser2 в example-схеме без ключа `overtime` (после снятия парсеров §5.1 неактуально).

### 6.4 SMS-оповещение вместо поллинга (целевая модель, SPEC §6.2)

**Поллинг не используется в целевой модели.** По завершению n8n шлёт SMS запустившему
(«результат готов, можно подтянуть»); юзер жмёт «Подтянуть результат AI» → фронт читает
`AI_teams_schedule` по `request_ID`. `request_ID` хранить надёжно (localStorage + привязка к юзеру).
Реализация: оживить SMS-ноду (Twilio) в конец после `Update a row`.
> ⚠️ Противоречие в доках: cit7-разборы описывают потребителя, который **поллит Supabase**; SPEC/
> AUDIT — целевую модель **SMS→Pull** (поллинг убрать). Это разные срезы: текущая реализация vs
> цель. Twilio-нода в одном срезе помечена как удалённая (cit7-deep-audit §0), в SPEC/AI-MODULES —
> как ноду, которую надо оживить/подключить.

---

## 7. Slack-рассыльщик

🟢 Отправка в Slack — целевой финальный шаг; воркфлоу по докам Disabled, требует включения.

**Воркфлоу `aa6XaAQ6xuLEZRcz`** «Task Planner - sender (slack)»,
webhook `POST /webhook/67341a95-2c54-4154-b7cc-ca6f2af0077e`:
```
Webhook → Code - general schedule → Send a message (канал test-bot-helper C09K2FC527M)
        → Code - separate schedule → Send a message3 (DM) → Respond to Webhook
```
- `Code - general schedule` — единый текст по бригадам: `*Schedule for <date>*`, время жирным,
  адрес → Google Maps-ссылка, travel time.
- `Code - separate schedule` — персональные DM; маппинг **`TEAM_TO_USER` захардкожен**
  (`Gheorghe Caminschi → U0988MNV954`, остальные — заглушки `UXXXXXXXX`).

**Тестовый рассыльщик `9MFaoXbtsU5SwvzB`** (тот же webhook `67341a95…`) — более новая логика:
`slack_user_id` берётся **из входных полей** (`slack_user_id`/`slack_id`/`slack.user_id`,
форматы `<@U123>`, `@U123`, `U123`) без хардкода; project channel `<#C…>`; баннер
`*THIS IS ONLY A TEST !!!*`; `unfurlLinks/Media:false`; каналы `test-scheduler` (C09K1PX0XLH),
`test-bot-helper` (C09K2FC527M).

> **Рекомендация:** перенести подход с `slack_user_id` из payload (тест-рассыльщик) в прод-рассыльщик
> вместо хардкода `TEAM_TO_USER`.

**Контракт (SPEC §6.4):** Slack уходит отдельным шагом после статуса Scheduled и нажатия ПМ.
`POST {N8N_SLACK_WEBHOOK}`: `{ request_ID, timestamp, teams:[{team_name, tasks:[…]}] }`.
Осталось (тех): где хранить `slack_user_id`, заполнить `TEAM_TO_USER`, включить воркфлоу.
⏳ Тестировать Slack **только после** стабильного планировщика.

**Оркестрация (не подтверждено):** кто дёргает оба webhook и передаёт результат планировщика
рассыльщику — внутри n8n прямой связи между группами нет, оркестрация внешняя.

### Родственные воркфлоу (кандидаты в архив / история)
| ID | Имя | Статус |
|---|---|---|
| `cit7Gah53xPLLbdy` | Task Planner | 🟢 ПРОД active |
| `p3uLQZZwWGbTIic6` | Task Planner main flow | 🕘 inactive — предшественник cit7, использовал Airtable + Supabase |
| `lvUAxW5QbwT3lOBH` | Task Planner main flow test | 🕘 inactive — тест, sonnet-4 (skills) + gpt-5 (route), полные промпты route-агентов как референс; в нём есть обвязка ретраев для переноса |
| `aa6XaAQ6xuLEZRcz` | sender (slack) | прод-рассыльщик, Disabled |
| `9MFaoXbtsU5SwvzB` | sender to slack test | тест-рассыльщик |

> Все inactive используют тот же webhook-путь, поэтому одновременно активен только один планировщик.

---

## 8. Исторический контекст

🕘 Старый отдельный фронт «Daly Schedule» уже вплавлён в портал; ниже — кратко, для истории.
Бизнес-правила (движок, якоря, скиллы) вынесены в §2 как актуальные.

### 8.1 Миграция Lovable → фронт → портал
- Не переписывали с нуля: новый фронт `apps/task-planner` (React+Vite+TS) реализовал ядро
  (Tasks/Create/Availability/Admin/Profile/Login + движок якорей + Google travel + Proposed-редактор).
- Довели до паритета с Lovable, убрали dev-каркас, провязали на прод.
- **Синк справочников — через Supabase Edge Functions (не n8n):** `sync-airtable-projects`,
  `sync-airtable-teams`, `sync-airtable-skills`, `sync-team-accounts`, оркестратор
  `auto-sync-airtable`. Вызов `supabase.functions.invoke('<fn>')`.
- **Архитектура — мульти-апп портал** (решено 2026-07-02): Task Planner — одно из приложений,
  открывается карточкой как отдельный SPA со своим Supabase; вход/идентичность/User Management —
  на уровне портала; SSO-хэндофф сессии между апками. Доступ к приложениям назначается **на роль**
  (роль → мультиселект приложений), вручную в User Management; User Management только для
  `is_admin`; юзеры заводятся вручную заранее (whitelist по email).

### 8.2 Экраны фронта (Daly Schedule / task-planner)
Тёмный хедер `DALY SCHEDULE`, меню: Create Task · Tasks · Teams Availability · Admin · Profile ·
Sign out. Данные из Supabase под user-JWT.
- **`/tasks`** — три вью: **Requested** (список/создание, Send to AI), **Proposed** (drag, правка
  Duration/Travel, движок пересчёта, Approve All → Scheduled, Explain Yourself, Подтянуть результат
  AI), **Scheduled** (read-only + Send to Slack).
- **`/create`** — Project/Other, поля, тумблер EXACT/TIMEFRAME, Skills, Additional Stop.
- **`/availability`** — недоступность бригад → `team_availability` → исключаются планировщиком.
- **`/admin`** — справочники Projects/Teams/Skills/Task Types + Sync from Airtable.
- **`/profile`, `/login`** — профиль/пароль, Supabase Auth.

### 8.3 Аудит СТАРОГО фронта (AUDIT.md, 2026-06-29) 🕘
Аудит именно старого фронта `frontend/src` (НЕ портала). Ключевые категории (детали в источнике):
- **Хардкод:** `TEST_ANCHOR_TIMES` (H-1, P0), приоритеты в CreateTask (H-2), плейсхолдер домена (H-3).
- **Dev-механика к снятию:** «Test Send to AI», «Reset test set», `materializeProposedCopies`,
  `deleteTasksByStatus`, `replaceProposedWithSchedule`, `restoreRequestedFromRun` (D-1…D-6, P0) →
  заменить на плавный переход статусов.
- **Дыры:** мёртвые кнопки Profile (G-1), нерабочая форма Availability (G-2), User Management
  `alert('coming soon')` (G-3), слабая валидация CreateTask (G-4), тихий фолбэк Maps на haversine
  (G-5), отсутствие loading/error UI (G-6), нетипизированные AI-комментарии (G-7/G-8).
> После вплавления в портал большинство этих пунктов относится к устаревшей кодовой базе;
> актуальны как чек-лист паритета, если что-то переносилось.

### 8.4 Прод-провязка (чек-лист, MIGRATION §5) 🕘/частично 🟢
env прод (Supabase/n8n/Google, убрать `*_TEST_WEBHOOK`); Send to AI → SMS/Pull; прод-модель задач
(1 строка, плавный статус); Slack workflow + `TEAM_TO_USER`; RLS под роли; Google Maps прод-ключ
(был restricted на :5174); хостинг фронта; **ротация `service_role`** перед продом (давался разово
для снятия схемы).

---

## 9. Открытые вопросы к клиенту

❓ Сведено из SPEC §10, AUDIT §6, MIGRATION §7–8. Часть закрыта 2026-07-02 (мульти-апп портал, §8.1).

- 🕗 **Строгие рабочие часы** (старт/конец/макс.часы/запрет ночи/обед) — сейчас нет hard-constraint,
  возможны вечерние смены. Если есть — добавить в промпты агентов + проверку.
- Использовать ли **timeframe-окна** и как (§2.5).
- **Модель travel/пробок:** авто-пересчёт vs ручная кнопка; нужен ли traffic (§2.7).
- **Срок хранения** Scheduled (сейчас ~1 мес).
- Нужен ли **архив** (`archived`) и зачем.
- **Роли/RLS внутри Task Planner** (`super_admin/pm/team_lead`), состав ПМ-вью, соотношение
  портал-доступа и внутренних ролей (блок D в MIGRATION).
- **Slack:** где `slack_user_id`, формат payload.
- **S3:** политика дат (один день vs мульти-дата).

**Решено (разработка):** доп.остановка — модель B (§2.8); round-trip по `task_id` без
оригинал/копия (§2.3); мульти-апп портал, доступ на роль, whitelist-заведение юзеров (§8.1).

---

## 10. Хронология и эволюция

Модели агентов и структура парсеров **менялись во времени** — при чтении старых доков учитывать срез.

| Дата | Событие | Источник |
|---|---|---|
| 2026-06-15 | Срез cit7-prod-analysis: имя «( need to check )», executions=0. Модели: skills=**gpt-4**, route=**gpt-5**, inserter=**claude-opus-4-5**. Строгие Structured Output Parsers. | cit7-prod-analysis |
| 2026-06-17 | Первый реальный прогон (execution `187122`): 16 задач/8 бригад/92 скилла/0 anchors, happy-path. Воркфлоу переименован в `Task Planner`, удалены висячие модель-ноды и мёртвая Twilio-нода. | cit7-deep-audit |
| 2026-06-22→23 | Change 1 (тег­гер gpt-4o + relaxed Parser1), **Change 2** (матчер с уровнями) + **Change 3** (промпт inserter'а с уровнями) применены на basement (прод) и подготовлены для t3d. Поля Persistent/One-time Prompt убраны из фронта. | n8n-skill-level-changes, SPEC |
| 2026-06-23 | SPEC обновлён (источник правды по бизнес-правилам). | SPEC |
| 2026-06-24 | Срез AI-MODULES: **все 3 агента на gpt-5**. | AI-MODULES |
| 2026-06-25 | **Structured Output Parsers сняты у всех 3 агентов**, заменены Code-нодами (`Parse Skills/Route/Insert`), merge → `Merge comments`. Подтверждено полным прогоном (req `f37c604a`): 16/16, якоря на месте, 0 unscheduled. | AI-MODULES |
| 2026-06-29 | AUDIT старого фронта + MIGRATION Lovable→фронт. | AUDIT, MIGRATION |
| 2026-07-02 | Закрыты вопросы по мульти-апп порталу; реализовано в `apps/portal`. | MIGRATION |
| позже | Task Planner вплавлён в портал как маршруты (см. git-историю InternalApps). | — |

### Замеченные противоречия между доками
1. **Модели агентов** — самое крупное расхождение, объясняется эволюцией по датам: gpt-4/gpt-5/
   opus-4-5 (2026-06-15) → tagger gpt-4o (06-23) → все gpt-5 (06-24). analysis.md вообще пишет «opus-4-5
   и/или gpt-5, несколько lmChat-нод (2× opus, 2× gpt-5, 1× gpt-4)». Актуальным считать последний
   срез, но модель конкретной ноды проверять в живом воркфлоу.
2. **Structured Output Parsers** — cit7-* и analysis описывают строгие парсеры как активные;
   AI-MODULES (06-25) фиксирует их снятие. Промпт-док inserter'а ссылается на Parser3 — после 06-25
   неактуально.
3. **Баг `Assigned tasks Agent` vs `…Agent1`** — cit7-разборы: активный баг (comments теряются);
   n8n-skill-level-changes: «баг закрыт». Разные срезы; в живой системе проверять имя в `Merge comments`.
4. **Поллинг vs SMS** — cit7-разборы: потребитель поллит Supabase; SPEC/AUDIT: целевая модель SMS→Pull
   без поллинга. Текущая реализация vs цель.
5. **Twilio SMS-нода** — cit7-deep-audit: удалена; cit7-prod-analysis/analysis: присутствует (мёртвая);
   SPEC/AI-MODULES: оживить. Срезы разного времени.
6. **Имя inserter-ноды** — basement `Other tasks Agent1` vs t3d `Other tasks Agent` (не противоречие,
   а различие инстансов — важно при правках).
7. **Мандат inserter'а** — строгий no-reschedule (cit7-prod-analysis) vs гибкий (cit7-inserter-prompt-
   flexible) — незакрытый выбор политики (S6), а не ошибка.
