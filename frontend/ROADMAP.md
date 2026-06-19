# Daly Schedule — Roadmap & Progress

Новый фронтенд взамен Lovable. Архитектура — [`README.md`](./README.md).
Срез: 2026-06-18.

---

## 🔖 Хэндофф (последняя сессия 2026-06-18)

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

## 🚧 В работе / дальше

### Ближайшее
- [ ] **Вставить `VITE_GOOGLE_MAPS_API_KEY`** и проверить Matrix на реальных адресах (см. Хэндофф).
- [ ] **Проверить запись вживую под PM** — Create Task / Send to AI / Approve / Send tasks
      на реальной БД (сверить имена колонок, RLS на запись).
- [ ] Уточнить и подогнать **payload Slack-рассыльщика** (сейчас `{schedule: TeamDay[]}`).
- [ ] Ручной **override travel** в ячейке (пометить ребро как зафиксированное, не пересчитывать).
- [ ] Edit/Delete задачи (иконки есть, нужен функционал).

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
