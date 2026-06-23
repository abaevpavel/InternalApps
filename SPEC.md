# Daly Schedule — Спецификация проекта

> Источник правды по проекту. Готов к переносу в Confluence. Обновлено: 2026-06-23.
> Детали движка пересчёта — [`frontend/README.md`](frontend/README.md) §8.
> Разбор n8n — [`cit7-prod-analysis.md`](cit7-prod-analysis.md), [`cit7-deep-audit.md`](cit7-deep-audit.md).

---

## 1. Что это и зачем

Веб-приложение для планирования **дневных расписаний бригад** компании
basementremodeling.com (ремонт подвалов, регион DC/MD/VA). Заменяет старый фронт на
Lovable (его пересчёт времён ломал якоря).

Project manager (ПМ) собирает задачи на день → отправляет AI-планировщику (n8n) →
получает черновое расписание по бригадам → правит вручную → одобряет → рассылает
бригадам в Slack.

```
[Create Task] → Requested → (Send to AI → n8n) → Proposed → (правки + Approve) → Scheduled → (Send → Slack)
```

**Стек:** React 18 + Vite + TS, TanStack Query, Zustand, Supabase (БД+Auth), Google
Maps Distance Matrix (travel), Tailwind/shadcn, dnd-kit. Бэкенд-планировщик — n8n
(LLM-агенты). Справочники синкаются из Airtable.

---

## 2. Архитектура и критические факты

| Слой | Что |
|---|---|
| Фронт | SPA: UI → state (Query/Zustand) → `scheduling-engine` (чистый, тестируемый) → сервисы (Supabase/n8n/Maps) |
| Supabase | проект «crews scheduling» `dhtewaqfcsejdllwhgtl`. Auth email+пароль. Фронт = anon-ключ + user-JWT |
| n8n | планировщик-воркфлоу `cit7Gah53xPLLbdy` «Task Planner» (LLM-агенты) |

**Инстансы n8n:**

| Инстанс | Роль | Webhook |
|---|---|---|
| `basementremodeling.app.n8n.cloud` | **ПРОД (рабочий, канон)** | `/webhook/d3dfcd18…` |
| `t3d-projects.app.n8n.cloud` | временный (пока не хватало кредитов basement) | `/webhook-test/d3dfcd18…` |

→ Работаем на **basement**. В перспективе — переезд на **self-hosted n8n на VPS**.

**🔴 Критично держать в голове:**
- **RLS:** таблица `tasks` доступна только **authenticated** (под логином). Любые
  правки задач — только из браузера под юзером (serverless-ключом нельзя).
- **Единая Supabase:** n8n обязан писать результат в **ту же** базу
  (`dhtewaqfcsejdllwhgtl`/`AI_teams_schedule`), что читает фронт. Иначе кнопка
  «Подтянуть» ничего не найдёт. → проверить кред в ноде `Update a row`.

---

## 3. Модель данных

### `tasks` (ядро)
`id`, `status`(`requested|proposed|scheduled|archived`), `task_type`, `project_id?`,
`description`, `scheduled_date`, `scheduled_time`(jsonb, §5.1), `estimated_duration`
(в БД часы; в домене минуты), `address/lat/lng`, `project_manager`, `team_id?`
(null=unassigned), `priority`(5=normal), `skill_requirements[]`, `schedule_prompt?`,
`additional_stop?`(jsonb), `stop_number?`, `travel_time?`, `request_task_id?`
(proposed-копия → исходная задача), `title?`, аудит-поля.

### `AI_teams_schedule` (история прогонов)
`request_ID`(text), `input_tasks`(jsonb — снимок входа), `output_data`(jsonb —
`{schedule:[{date,tasks…}], commentsAI-1, commentsAI-2}`), `created_at`.
- Хранение **входа и выхода** позволяет: сверять где не совпало и **прогонять заново** (§6.3).
- Готовность результата = появилось `output_data.schedule`.

### Справочники (синк из Airtable)
`projects`, `teams` (+ скиллы через текст в `skills.description`), `skills`,
`task_types`, `team_availability`, `user_roles` (enum `app_role`).

---

## 4. Жизненный цикл задачи (статусы)

| Статус | Смысл | Действия |
|---|---|---|
| **Requested** | **Эталонный набор**, не расходуется. Send to AI его НЕ трогает | Create Task, Send to AI, «↺ Сбросить тестовый набор» |
| **Proposed** | **Копии** результата ИИ (`request_task_id`→оригинал). Здесь движок и правки | «Подтянуть результат AI», правки/drag, Approve All, «🗑 Удалить все» |
| **Scheduled** | Одобренный план. Остаётся со своей датой, хранение **~1 мес** (срок уточнить у клиента) | Send to Slack |
| Archived | Архив | — |

**Принцип:** Requested = неизменный набор для повторных тестов; каждый прогон создаёт
свежие Proposed-копии; «Удалить все» чистит Proposed, не трогая Requested.

> ⚠️ **Копирование Requested→Proposed — это механика ТОЛЬКО на время тестирования**
> (чтобы гонять один набор по кругу). В **проде** будет **плавный переход статусов
> задачи** (одна строка движется requested→proposed→scheduled, без дублирования).

---

## 5. Доменные правила

### 5.1 Якоря (exact time)
- Задача с `time_type=exact` + `exact_time` = **якорь** (жёсткое время старта).
- **Формат для ИИ:** `{ "type": "exact", "time": "HH:MM" }` (НЕ `start`).
  Timeframe — `{ "type": "timeframe", "start", "end" }`.
- **Невалидно:** exact без времени — **запрещено** (Create Task не сохраняет).
- **Инварианты движка:** `anchor=true` ⇒ `start == anchor_time` всегда; перед якорем
  допустим простой; недоезд → не двигаем якорь, помечаем `conflict` (UI красным).

### 5.2 Timeframe (окно)
- Окно `{start,end}`, заранее заданное в задаче (альтернатива exact).
- **Пока НЕ используется.** Поле оставляем; нужно ли применять — **уточнить у клиента**.
  (Предложение на будущее: задача стартует внутри окна, иначе conflict.)

### 5.3 Скиллы и уровни
- Связь скилл↔команда — текст в `skills.description` («Available teams: rec…»), ключ
  `team.airtable_id`.
- **Уровень** = суффикс `"- N"`; **level 1 = высший приоритет** (меньше = лучше).
- Фронт шлёт `team.skills` как `[{name, level}]`. Тег­гер (LLM) навешивает скиллы из
  описания (голые имена); матчинг по имени, ранжирование по уровню (`optional_team_level`).

### 5.4 Travel и пробки ⚠️ (модель к согласованию с клиентом)
Проблема: реальное время в пути зависит от **пробок** (время суток). Считать это
надёжно в LLM нельзя.

**Принятая модель (предложение, обсудить с клиентом):**
1. **Планировщик (n8n)** считает travel **БЕЗ пробок** — грубая, стабильная оценка
   (для порядка задач и выполнимости). Дёшево и детерминированно.
2. **Фронт (Proposed)** даёт реальный travel **отдельным явным шагом** — кнопка
   **«Пересчитать travel (Google)»**: по каждому участку запрос Distance Matrix с
   `departure_time` = плановое время выезда + `traffic_model=best_guess` → реальное
   время с пробками. Движок пересчитывает, якоря держатся, конфликты подсвечиваются.
   Кэш по `(откуда, куда, time-bucket)`.

**Общие правила travel (зафиксированы):**
- Travel **входит в рабочее время**.
- Доезд от дома к первой задаче — **не** рабочее время (в расписании `drive=0` у первой).
- Доезд домой после последней — **не** рабочее время.
- У каждой бригады есть **стартовое место (home base)** — участвует в подсчётах.
- Источник истины — Google; перетирает оценку планировщика (кроме ручного override).

### 5.5 Additional stop (доп. остановка) — обязательна, если задана
- `{when:'before'|'after', address, lat, lng, duration_min, …}`.
- Если задана — **обязательна**, считается как полноценный пункт маршрута.
- `after`: travel **задача → остановка → следующая задача** (крюк в travel следующей).
- `before`: travel **предыдущая задача → остановка → задача** (крюк в travel текущей).
- Длительность задачи не меняется; время остановки = `duration_min`.

### 5.6 Рабочий день / overtime
`working_min = Σ длительностей + Σ inter-task drives + Σ длительностей остановок`.
День: ≤480 `normal` | 481–600 `overtime_8_to_10` | >600 `overtime_over_10`.

### 5.7 🔴 Round-trip целостность (НИЧЕГО не теряется)
**Всё, что отправлено в ИИ, имеет значение и не должно теряться.** Если выход ИИ не
содержит поле, которое было на входе (например `priority`, `skill_requirements`) —
это **баг**.
- Proposed-задача = **оригинал (все поля)** + наложение расписания из `output_data` по
  `task_id` (время, бригада, порядок, travel). Поля вроде `priority`/`skills` берём из
  оригинала по `request_task_id`, а не теряем.
- Добавить проверку: каждое входное `task_id` присутствует в выходе ровно один раз
  (или в `unscheduled` с причиной).

---

## 6. Интеграция с n8n

### 6.1 Send to AI (планировщик)
`POST {N8N_PLANNER_WEBHOOK}`:
`{ request_ID, date (один день), source, tasks[] (scheduled_time в формате §5.1),
Teams[] (name/address/lat/lng/skills[{name,level}]), "Unavailable teams"[], Skills[], total }`.
Ответ — **ack**, не расписание.

### 6.2 Готовность результата — БЕЗ поллинга (SMS → Подтянуть)
- **Поллинг не используется.** По завершению сценария n8n шлёт **SMS** запустившему:
  «результат готов, можно подтянуть».
- Юзер жмёт **«Подтянуть результат AI»** → фронт читает `AI_teams_schedule` по
  `request_ID` → материализует `output_data.schedule` в Proposed.
- 🔴 **`request_ID` хранить надёжно** (localStorage + привязка к юзеру), чтобы не
  потерять, как подтянуть.

### 6.3 Повторный прогон сценария (новая фича — спроектировать)
Поскольку в `AI_teams_schedule` хранятся и вход (`input_tasks`), и выход
(`output_data`) — можно сверять, где не совпало, и **прогонять заново**:
- Кнопка **«Прогнать заново»** (по `request_ID` / дню): берёт сохранённый вход (или
  текущие Requested) и запускает новый прогон планировщика. Новый `request_ID`; старый
  прогон остаётся в истории для сравнения.
- Цель: тестировать/перезапускать без ручной пересборки задач.

### 6.4 Slack (Send tasks)
- В Slack уходит **отдельным шагом** после того, как задачи в статусе **Scheduled** и
  ПМ нажал «отправить».
- `POST {N8N_SLACK_WEBHOOK}`: `{ request_ID, timestamp, teams:[{team_name, tasks:[…]}] }`.
- Остаётся (тех): где хранить `slack_user_id`, заполнить `TEAM_TO_USER`, включить
  воркфлоу-рассыльщик `aa6XaAQ6xuLEZRcz` (сейчас Disabled).

---

## 7. n8n: пайплайн и надёжность

**Пайплайн `cit7`:** Webhook → Edit Fields2 → (ack)+Create row → filter unavailable →
filter unassigned → тег­гер `Unassigned Tasks with skills` (**gpt-5**) → Fields →
матчер `unassigned tasks with optional teams` → `Assigned tasks Agent` (маршруты) →
инсертер `Other tasks Agent(1)` → Code (merge) → Edit Fields3 → Update a row.
- Имя инсертера различается: basement = `Other tasks Agent1`, t3d = `Other tasks Agent`.
- Тег­гер на gpt-4o падал `Model output doesn't fit required format` → **gpt-5 чинит**.
- Учёт уровня скилла (Change 2 матчер + Change 3 промпт): на basement применено,
  на t3d — патч `t3d-planner.patched.json`.

### Рекомендации по надёжности (B-14, делаем поэтапно)

| Нода | Что добавить | Зачем |
|---|---|---|
| Агенты: тег­гер, `Assigned tasks Agent`, `Other tasks Agent(1)` | `retryOnFail` + `maxTries 2–3` + `waitBetweenTries ~2000ms` | LLM иногда таймаутит/кривой формат — ретрай спасает |
| `Structured Output Parser 1/2/3` | включить **Auto-Fix** (с моделью) | модель чуть промахнулась по схеме → авто-починка вместо падения |
| **SMS-нода** (сейчас мёртвый Twilio) | подключить в конец после `Update a row`, слать `request_ID` запустившему | это и есть SMS-оповещение из §6.2 — переиспользуем дохлую ноду |
| `Create a row1`, `Update a row` (Supabase) | `retryOnFail` + 2 попытки | сетевой сбой не должен терять результат |
| оба агента | промпт читает `scheduled_time.time` (не `.start`) | фронт уже выровнял формат — убрать рассинхрон |
| весь флоу | проверка round-trip: каждое `task_id` есть в выходе (§5.7) | не терять задачи/поля |

---

## 8. Auth, роли, видимость

- Supabase Auth (email+пароль). Роли — таблица `user_roles` (enum `app_role`:
  `super_admin | pm | team_lead`), RLS.
- **super_admin** — всё.
- **pm** — у него **отдельное урезанное вью** (другой функционал; состав экранов
  покажет юзер позже). Сейчас юзеры подтягиваются из БД и назначаются как ПМ.
- **team_lead** (бригадир) — read-only своё расписание (Scheduled) через RLS.
- Точные права/RLS — **уточнить у клиента**.

---

## 9. Фронт — экраны и функционал

**Навигация (после логина):** тёмный хедер `DALY SCHEDULE`, бургер-меню:
Create Task · Tasks · Teams Availability · Admin · Profile · Sign out.
Все данные — из Supabase (под user-JWT); справочники синкаются из Airtable.

### 9.1 `/tasks` — три вью задач (ключевой экран)
Общий источник: `tasks`, сгруппированы по бригадам (`assigned_team_id`).

| Вью | Что можно | Чего нельзя | Источник данных |
|---|---|---|---|
| **Requested** (смотрим/готовим) | смотреть список задач дня; создать (→ Create Task) и редактировать **детали** задачи (модалка: Title/Description/Duration/Priority/Date/Address, Delete); запустить **Send to AI / Test**; **↺ Сбросить тестовый набор** | перестановки/расписания нет (ИИ ещё не отрабатывал) | `tasks(status=requested)` + `teams` |
| **Proposed** (правим расписание) | **drag** задач, правка **Duration/Travel** (ручной override с «замком»); **движок пересчитывает** время (якоря держатся, конфликты красным); **Approve All**→Scheduled; **Explain Yourself** (комментарии ИИ); **Подтянуть результат AI**; **🗑 Удалить все** | — | `tasks(status=proposed)` + `AI_teams_schedule`(комментарии) |
| **Scheduled** (финал) | смотреть одобренный план; **Send tasks** (Slack) | **перемещать/редактировать нельзя** (read-only) | `tasks(status=scheduled)` |

**Правила перемещения (требование):**
- Requested — view списка, расписание не двигаем.
- **Proposed — можно перемещать задачи внутри бригады И между бригадами**, с
  **полным пересчётом времени обеих** затронутых бригад (старой и новой) с учётом
  переносимой задачи. ⚠️ **Сейчас drag только ВНУТРИ бригады** — перемещение между
  бригадами + пересчёт обеих = **TODO**.
- Scheduled — перемещение и редактирование **запрещены**.

> ⚠️ Сверить: сейчас в Requested есть Edit/Delete задачи. Если по правилу «в первом
> только смотрим» редактирование там не нужно — убрать/перенести (уточнить).

### 9.2 `/create` — Create Task
Форма: тип **Project / Other**; поля — Select Project (из `projects`), Task Type,
Description, Date, **Time** (тумблер `EXACT TIME` / `TIMEFRAME`; exact обязан иметь
время — §5.1), Duration (часы), Assigned Team (из `teams`, опц.), Skills (из `skills`),
Additional Stop (Before/After + адрес — §5.5). Сохранение → `tasks(status=requested)`.

### 9.3 `/availability` — Teams Availability
Задание **недоступности бригад** (даты) → `team_availability`. Эти бригады
исключаются планировщиком (`Unavailable teams` в payload).

### 9.4 `/admin` — Admin
Справочники **Projects / Teams / Skills / Task Types** (просмотр/правка) +
кнопка **Sync from Airtable** (обновить справочники из Airtable).

### 9.5 `/profile` и `/login`
Profile — данные юзера, смена пароля. Login — Supabase Auth (email+пароль).

> Под роль **pm** — отдельное урезанное вью (состав экранов покажет юзер, §8).

---

## 10. Открытые вопросы

**К клиенту:**
- Использовать ли timeframe-окна и как (§5.2).
- Модель travel/пробок: автоматический пересчёт vs ручная кнопка; нужен ли traffic (§5.4).
- Срок хранения Scheduled (сейчас ~1 мес) (§4).
- Точные права и RLS для `pm`/`team_lead`, состав ПМ-вью (§8).
- Slack: где `slack_user_id`, формат payload, включение воркфлоу (§6.4).

**Перед продом:**
- 🔐 **Перевыпустить `service_role` ключ** Supabase (давался разово для снятия схемы;
  во фронте его нет; старый — ротировать).
- Подтвердить, что n8n (`Update a row`) пишет в Supabase фронта (§2).
- Хостинг фронта (сейчас **stage**) и где хранить env (Supabase anon, Google Maps key
  — сейчас referrer-restricted на :5174, n8n webhooks).
- Вернуть тест-webhook фронта на basement, когда восстановятся кредиты.

---

## 11. Сделано / TODO

**Сделано (2026-06-23):** тег­гер→gpt-5; формат якоря `{type:'exact',time}`; модель
Requested(эталон)/Proposed(копии) + «Удалить все» + «Сбросить набор»; восстановление
по `request_ID` (localStorage) + кнопка «Подтянуть»; скилл-уровни (фронт + n8n
Change 2/3); убраны поля Persistent/One-time Prompt.

**TODO (код):**
- Send to AI: убрать блокирующий поллинг → «выстрелил + сохранил `request_ID`, ждём
  SMS, далее Подтянуть» (§6.2).
- Create Task: запрет Exact без времени (§5.1).
- Proposed-копии: обогащать из оригинала по `request_task_id` — не терять
  priority/skills (§5.7).
- Кнопка «Пересчитать travel (Google)» на фронте (§5.4).
- Фича «Прогнать заново» (§6.3).
- n8n: SMS-нода + ретраи агентов/парсеров + retry Supabase-нод (§7).
- **Proposed: drag между бригадами** + полный пересчёт обеих бригад (§9.1).
- **Прод: плавный переход статусов** (убрать тестовое дублирование Requested→Proposed) (§4).
- Уточнить правило редактирования в Requested (§9.1).
