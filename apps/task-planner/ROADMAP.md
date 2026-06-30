# Daly Schedule — Roadmap & Progress

Новый фронтенд взамен Lovable. Архитектура — [`README.md`](./README.md).
Срез: 2026-06-18.

---

## ▶️ ПРОДОЛЖИТЬ ЗАВТРА ОТСЮДА (2026-06-23)
Готовые n8n-правки на вставку — в **`../n8n-skill-level-changes.md`**:
матчер (Code-нода `unassigned tasks with optional teams`) + промпт `Other tasks Agent`
под скилл-матчинг с учётом уровня. Фронт уже шлёт `{name, level}`; без обновления
матчера задачи валятся в unscheduled (ждёт строки, получает объекты). Дальше — прогон теста.

---

## 🔖 Хэндофф (последняя сессия 2026-06-22)

**Что сделано в этой сессии (фронт):**
- **Slack payload (был баг)** — фронт слал `{ schedule: TeamDay[] }`, а воркфлоу
  `aa6XaAQ6...` ждёт `{ request_ID, timestamp, teams: [{ team_name, tasks[] }] }`.
  Добавлен `buildSlackPayload()` (`n8n.ts`), `Scheduled` шлёт по контракту.
- **Ручной override travel** (Proposed) — движок это уже умел (`travel_overridden`),
  добавлен UI: замок 🔓→🔒 в строке фиксирует travel вручную, повторный клик → авто.
- **Edit/Delete задач** — `TaskEditModal` + `updateTask`/`deleteTask` (`data.ts`),
  карандаш в карточке Requested открывает модалку (Title/Desc/Duration/Priority/Date/Address).
- **`fetchTeams` теперь отдаёт реальные скиллы команд** (было захардкожено `[]`).
  Источник — `skills.description` ("Available teams: recAAA, recBBB"), инверсия
  скилл→команды в команда→скиллы по `team.airtable_id`.
- **Скиллы команд несут уровень**: тип `TeamSkill { name, level }`, `splitSkillLevel()`
  режет суффикс `"- N"` → `{name, level}`. Payload: `skills: [{ name, level }]`.
- **`additional_stop`: нормализация `timing`→`when`** в `mapDbTask` (БД хранит `timing`,
  движок/типы ждут `when` — иначе локальный пересчёт игнорировал крюк).
- **Тестовый webhook планировщика** → `VITE_N8N_PLANNER_TEST_WEBHOOK` =
  `t3d-projects.app.n8n.cloud/webhook-test/d3dfcd18-...` (новый инстанс, см. ниже).
- Проверено: все 20 колонок `tasks` существуют (зонд PostgREST) — INSERT/UPDATE не упадёт на именах.
- Состояние: `tsc` чистый, тесты 3/3, сборка зелёная. Dev: http://localhost:5174.

**Ключевые находки (модель данных и пайплайн):**
- **Скилл↔команда хранится как свободный текст** в `skills.description`
  (`"Available teams: <airtable_id>, ..."`), ключ — `team.airtable_id` (Airtable rec…,
  НЕ Supabase uuid). Хрупко; в идеале вынести в таблицу `team_skills`.
- **Уровень скилла** закодирован суффиксом `"- 1/2/3"` в имени скилла.
  **level 1 = высший приоритет** (предпочитать меньший номер). Многие скиллы дублируются
  (голое имя + варианты `- 1/2/3`).
- **Тег­гер выдаёт ГОЛЫЕ имена скиллов** (без уровня); команды несут leveled.
  → матчинг должен быть **по базовому имени**, ранжирование **по min(level)**.
- **Payload, приходящий в планировщик, рестрктурится n8n-нодой** (`unassigned/assigned
  tasks`, `available teams`, `skills` lowercase) — это НЕ сырой payload фронта.
- **Поле задачи — `skill_requirements`**, а тег­гер пишет в `skills` → нужна merge-нода,
  кладущая результат тег­гера в `skill_requirements` (иначе скиллы теряются).
- **Новый инстанс n8n: `t3d-projects.app.n8n.cloud`** (рабочий аккаунт) — похоже, переезд
  с `basementremodeling`. Тестовый планировщик уже там; прод-планировщик и Slack-вебхуки
  во фронте всё ещё на `basementremodeling`.
- **AI-тег­гер падал** `Model output doesn't fit required format`: модель `gpt-4` (старая)
  + строгая «все поля required» схема + Auto-Fix off. Лечение: `gpt-4o` + Auto-Fix on
  + JSON Schema с required только `id`+`skills`.
- **Slack-воркфлоу Disabled**, `TEAM_TO_USER` почти весь placeholder (реальный Slack ID
  только у Gheorghe Caminschi).
- **Грязь в тестовых данных**: `\\n` (двойное экранирование) в описаниях; `type:"exact"`
  с пустым `start` (битый якорь); ночные `scheduled_time` (23:45/01:15/21:45);
  двойные/хвостовые пробелы в именах команд.

**Тронутые файлы:** `services/data.ts` (fetchTeams+скиллы, splitSkillLevel,
updateTask/deleteTask, timing→when), `services/n8n.ts` (buildSlackPayload),
`pages/Tasks.tsx` (override-UI + Edit/Delete модалка + slack-вызов),
`domain/types.ts` (TeamSkill).

---

## 🔖 Хэндофф (сессия 2026-06-18)

**Что сделано в этой сессии:** подключён сквозной флоу Requested → Send to AI →
Proposed → Approve → Scheduled → Send tasks; добавлен слой записи в Supabase;
Create Task делает реальный INSERT; **travel переведён на Google Distance Matrix**
(с учётом пробок) с живым пересчётом при правках. Подробности — в разделах ниже.

**Состояние:** `tsc` чистый, тесты 3/3, прод-сборка зелёная. Dev: http://localhost:5174.

**Чтобы продолжить — нужно сделать:**
1. **Вставить Google-ключ** в `frontend/.env` → `VITE_GOOGLE_MAPS_API_KEY=...`
   (в Google Cloud включить *Maps JavaScript API* + *Distance Matrix API*,
   referrer-ограничение `http://localhost:5174/*`). Перезапустить `npm run dev`.
2. **Проверить вживую под залогиненным PM** (без сессии RLS отдаёт 0 строк из `tasks`,
   UI висит на mock-fallback). `tasks` в БД сейчас физически пуст — первую задачу
   создать через Create Task.
3. **Сверить имена колонок записи** в `tasks` (брал из `mapDbTask`: `status`,
   `scheduled_time` jsonb, `team_id`, `stop_number`, `estimated_duration` в часах,
   `address`, `additional_stop`, `skill_requirements`, `created_by`). Если INSERT/UPDATE
   упадёт на имени колонки — поправить в `services/data.ts`.
4. **Уточнить контракт Slack-рассыльщика** — сейчас шлём `{ schedule: TeamDay[] }`
   (см. `sendToSlack`), точная форма payload не подтверждена доками.
5. **Закоммитить** изменения (ещё не коммитили).

**Тронутые файлы:** `services/data.ts` (+ write-функции, фикс join `teams`),
`services/n8n.ts` (payload под контракт cit7), `services/maps.ts` (Google Matrix),
`pages/Tasks.tsx` (все хендлеры + travel-матрица), `pages/CreateTask.tsx` (controlled + INSERT),
`package.json` (+`@types/google.maps`).

---

## ✅ Сделано

### Каркас
- React 18 + Vite + TypeScript, Tailwind, React Router, TanStack Query, Zustand.
- Структура: `app/` (router, layout, providers), `pages/`, `domain/`, `services/`,
  `components/`, `auth/`, `lib/`, `tests/`.
- Layout: тёмный хедер `DALY SCHEDULE — <SECTION>`, бургер-меню, защищённые роуты.
- Все экраны: Login, Tasks (Requested/Proposed/Scheduled), Create Task,
  Teams Availability, Admin (Projects/Team/Skills/Task Types), Profile.
- UI на английском. Сборка/typecheck чистые, dev на http://localhost:5173.

### Движок расписания (ядро, главный фикс)
- `domain/scheduling-engine.ts` — чистый, юнит-тесты (`tests/`, 3/3 зелёные).
- Повторяет модель старого приложения (3 шага: travel → additional stops → times),
  НО **фиксирует якоря** (`anchor=true` → start = anchor_time намертво).
- Additional Stops в travel-override модели (крюк перезаписывает travel соседней
  задачи: after → следующей, before → текущей) — 1:1 со старым `fullTaskRecalculation`.
- Конфликты: если к якорю не успеть — помечается, якорь не двигается.

### Supabase (реальная БД «crews scheduling»)
- Подключение по publishable-ключу + RLS; auth — Supabase (email/пароль + кнопка Google).
- Подтверждённая схема `tasks` (48 строк, по 16 на статус): `title, description,
  estimated_duration (часы), priority, status, scheduled_date, scheduled_time
  {start,end,anchor,anchor_time}, team_id, project_id, skill_requirements,
  additional_stop(+_duration), stop_number, travel_time, request_task_id`.
- `data.ts` — точный маппинг под реальные колонки (без догадок), join projects/teams
  для имён. Справочники (projects 118, teams 9, skills 92, task_types 8,
  team_availability) — на живых данных.
- **Все три вкладки Tasks отображают реальные задачи по статусу**, сгруппированные
  по бригадам (Requested — компактные карточки 2-в-ряд; Proposed — редактор;
  Scheduled — read-only).

### Редактор Proposed
- Drag-and-drop задач (dnd-kit) с автопересчётом времён движком.
- Модалка «Move anchored task?» при перемещении якоря **или** выталкивании чужого якоря.
- Inline-правка Duration → пересчёт; бейджи Total/Duration/Travel/overtime; conflict-флаги.

### Сквозной флоу (сессия 2026-06-18)
- **Слой записи** в `data.ts`: `createTask`, `updateTasksStatus(ids,status)`,
  `applyScheduleToTasks(days)` (пишет время/бригаду/порядок + `status=scheduled`).
- **Send to AI** (Requested): собирает задачи + teams/skills/unavailable + промпты
  (Persistent/One-time) → `sendToAi` → `pollScheduleRun` (крутилка, таймаут 5 мин) →
  помечает задачи `proposed` → автопереход на Proposed. Ошибки видны под кнопкой.
  Payload приведён к **точному контракту прод-воркфлоу cit7** (`n8n.ts`): вложенные
  `project{}`/`team{}`, `scheduled_time:{type,start,end}`, `estimated_duration` в часах.
- **Proposed теперь рендерится из результата поллинга** (`fetchScheduleRun` →
  `AI_teams_schedule.output_data.schedule`), а не из пересборки `tasks`. Правки
  (drag/duration) поднимаются наверх через `onComputed` и идут в Approve.
- **Approve All** → `applyScheduleToTasks` + статус `scheduled` → переход на Scheduled.
- **Explain Yourself** — модалка с `comments_ai_1/2` из прогона.
- **Send tasks** (Scheduled) → `sendToSlack({schedule})` с индикатором отправки.
- **Create Task** — форма стала controlled, делает реальный INSERT (status=requested) → redirect.
- **Фикс `fetchTasks`**: в схеме нет FK `tasks→teams`, embed `teams(name)` давал 400 и
  ронял весь экран (0 tasks / вечный Loading). Join убран, имя бригады резолвится из
  `teams` отдельным запросом.

### Travel через Google Distance Matrix (сессия 2026-06-18)
- `services/maps.ts` переписан: ленивая загрузка Maps JS SDK, `DistanceMatrixService`
  строит матрицу времён по **адресам** (дом → задачи → доп-стопы), координаты не нужны.
- **Учёт пробок** (`duration_in_traffic`, `departureTime` = день+09:00, только для будущих дат).
- **Глобальный кэш рёбер** по парам точек (реордеры/перемонтирования не дёргают API).
- **Фолбэк** на haversine (или числа AI как seed до загрузки матрицы), если ключа нет.
- `EditableTeamDay` больше не «замораживает» travel на числах AI — движок честно
  пересчитывает при перетаскивании/смене Duration/доп-стопах; индикатор «travel…».
- Доп-стопы: каждое плечо крюка (`from→stop`, `stop→to`) — отдельный запрос к матрице.

---

## 🔑 Google Maps API key (setup)

Нужен для travel через Distance Matrix (`services/maps.ts`). Заводится в
**Google Cloud Console** (https://console.cloud.google.com/).

**Что сделано / как заводили (2026-06-19):**
1. Создан проект в Google Cloud (organization = «No organization» — личный аккаунт ок).
2. Привязан **биллинг** (карта обязательна даже для бесплатного использования —
   только для верификации). Trial: **$300 кредита / 90 дней**. Сам по себе на платный
   НЕ переходит — пока вручную не нажать «Upgrade», списаний нет. У Maps Platform к тому же
   есть постоянный бесплатный месячный лимит — dev-нагрузке хватает с запасом.
3. Включены API: **Maps JavaScript API** + **Distance Matrix API**.
4. Создан **API key**, защищён: restriction type = **Websites**, referrer
   `http://localhost:5174/*` (+ можно `5173/*`). Доп. слой — API restriction на эти два API.
5. Ключ → `frontend/.env` → `VITE_GOOGLE_MAPS_API_KEY=AIza...`, перезапуск `npm run dev`.

**TODO при деплое:** добавить прод-домен в Website restrictions того же ключа
(Credentials → ключ → Add, напр. `https://<app>.vercel.app/*`). Localhost не удалять —
referrer'ов можно несколько. Referrer-ограничения «прорастают» до ~5 мин — если сразу
ловишь `RefererNotAllowed`, подожди.

**Без ключа** travel работает на haversine-фолбэке (прямое расстояние, без пробок) —
логика перестановок/пересчёта в Proposed от ключа не зависит.

---

## 🚧 В работе / дальше

### 🔴 Что менять на стороне n8n (обязательно — без этого матчинг слепой)
- [ ] **Матчер (Code-нода)**: сравнивать `task.skill_requirements[].name` с
      `team.skills[].name` (по базовому имени), среди подходящих команд выбирать
      **min(level)** (1 — высший приоритет).
- [ ] **Промпт планировщика**: описать новую форму `teams[].skills: [{name, level}]`
      и правило «level 1 — высший, предпочитать меньший номер».
- [ ] **Merge-нода**: класть результат тег­гера (`skills`) в `task.skill_requirements`
      (иначе проставленные скиллы теряются).
- [ ] **AI-тег­гер**: модель `gpt-4` → `gpt-4o`, включить **Auto-Fix Format**,
      схема — JSON Schema с required только `id`+`skills` (готовая схема — в чате сессии).
- [ ] **Решить по инстансу**: если переезжаем на `t3d-projects`, обновить во фронте
      и прод-планировщик (`VITE_N8N_PLANNER_WEBHOOK`), и Slack (`VITE_N8N_SLACK_WEBHOOK`).
- [ ] **Slack-доставка**: включить воркфлоу (сейчас Disabled) + заполнить `TEAM_TO_USER`
      реальными Slack ID (сейчас только Gheorghe).

### Ближайшее (фронт)
- [x] **Slack payload** — приведён к контракту воркфлоу (`buildSlackPayload`).
- [x] **Override travel** в ячейке Proposed (замок 🔓→🔒).
- [x] **Edit/Delete задач** (модалка в Requested).
- [x] **Скиллы команд** уходят в payload с уровнем (`{name, level}`).
- [x] `additional_stop`: нормализация `timing`→`when`.
- [ ] **Google Maps**: ключ вставлен — нужна живая проверка Matrix в браузере (консоль на `*MapError`).
- [ ] **Запись под PM**: имена колонок проверены ✅; осталось проверить **RLS на запись**
      (Create Task / Send to AI / Approve / Send tasks под залогиненным PM).
- [ ] Чистка данных: `\\n` (двойное экранирование), `type:"exact"` с пустым `start`,
      тримминг пробелов в именах команд — валидация на входе.

### Среднее
- [ ] Drag задач **между бригадами** (сейчас в пределах одной).
- [ ] Фильтры (Date/Search/Project/PM/TaskType) и группировки By Project/By Team.
- [ ] Teams Availability — реальная запись/удаление периодов.
- [ ] Admin — Sync from Airtable (триггер edge-функции), Profile — сохранение.
- [ ] Роли/RLS-гейтинг UI: super_admin / pm / team_lead (бригадир видит своё).

### Открытые вопросы (с клиентом)
- [ ] **Timeframe-задачи** — как окно `{start,end}` должно влиять на план.
- [ ] Смысл «доп. обязательная задача, подсветить перед клиентом».
- [ ] Формат payload `Send tasks` в Slack; маппинг team → slack_id.
- [ ] Хостинг (Vercel/Netlify/Render) + где env-ключи.

---

## ⚠️ Техдолг / безопасность
- [ ] **Rotate** secret/service_role ключ (использовался разово для снятия схемы).
- [ ] n8n параллельно НЕ чиним сейчас (баги известны — `../cit7-deep-audit.md`:
      пустой `commentsAI-1`, нет ретраев, temp≠0, timeframe игнорируется).
- [ ] Демо-fallback в `fetchTasks` (когда RLS не пускает) — убрать после стабилизации auth.
- [ ] React Router v7 future-flag warnings — опционально включить флаги.
