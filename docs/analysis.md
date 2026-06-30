# Task Planner — поузловой разбор

Детальный разбор воркфлоу из группы Task Planner. Высокоуровневый обзор и
таблица — в [`README.md`](./README.md).

---

## 1. Task Planner ( need to check ) — `cit7Gah53xPLLbdy` (ПРОД, active)

Webhook: `POST /webhook/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27`
Response: через ноду `Respond to Webhook` (синхронный ответ).

### Входной payload (body)
```
{
  request_ID,
  "Persistent Prompt",   // фронтенд-оверрайд, постоянный
  "One-time Prompt",     // фронтенд-оверрайд, разовый
  tasks: [ { id, description, estimated_duration, priority,
             scheduled_date, scheduled_time:{type:"exact"|"timeframe", start, end},
             project:{…}, team:{…}|null } ],
  Teams: [ { team_name, team_address, team_latitude, team_longitude, skills:[…] } ],
  "Unavailable teams": [ {team_name} ],
  Skills: [ … ]          // библиотека скиллов
}
```

### Поток узлов
| Узел | Тип | Что делает |
|------|-----|-----------|
| Webhook | webhook | приём POST |
| Create a row1 | supabase | пишет `input_body`+`request_ID` в `AI_teams_schedule` |
| Edit Fields2 | set | вытаскивает Teams / Unavailable teams / tasks / request_ID |
| filter unavailable | code | исключает недоступные бригады (нормализация имён, NFKC) |
| filter unassigned tasks | code | делит tasks на `assigned`/`unassigned`, группирует по бригадам, считает часы, сортирует по «весу времени» (exact=0, timeframe=1) |
| Edit Fields1 | set | собирает переменные для AI |
| Unassigned Tasks with skills | AI agent | по описанию задачи проставляет `skills` из библиотеки Skills |
| Fields | set | сохраняет результат скиллов |
| unassigned tasks with optional teams | code | матчинг «задача ↔ бригады, умеющие её сделать» по skills; строит `tasks_with_optional_teams` и `teams_with_optional_tasks` |
| Assigned tasks Agent1 | AI agent | **ROUTE & DAILY SCHEDULE BUILDER** — для уже назначенных бригад строит маршруты/таймлайн дня с реалистичным drive time (DC/MD/VA), учитывает anchors (exact-time, неподвижны), overtime-категории |
| Other tasks Agent1 | AI agent | **ASSIGNMENT & ROUTE INSERTER** — вставляет нераспределённые задачи в расписание, может двигать non-anchor задачи, не ломая anchors; скоринг по drive/overtime/priority |
| Code in JavaScript | code | сливает `commentsAI-1`/`commentsAI-2`, возвращает skills обратно в schedule |
| Edit Fields3 | set | формирует payload результата |
| Update a row | supabase | пишет `output_data` в `AI_teams_schedule` по `request_ID` |
| Edit Fields → Respond to Webhook | set/respond | синхронный ответ фронтенду |
| Send an SMS/MMS/WhatsApp message | twilio | SMS об окончании (тест-номер) |

### Модели
- `Assigned tasks Agent1` / `Other tasks Agent1` — Anthropic **claude-opus-4-5-20251101** и/или OpenAI **gpt-5** (несколько lmChat-нод: 2× opus-4-5, 2× gpt-5, 1× gpt-4).
- Structured Output Parser-ы задают строгую JSON-схему расписания (`schedule[]` + `comments{}`).

### Логика AI-агентов (важное)
- **Anchor** = задача с `scheduled_time.type=="exact"`. Неподвижна, не пересекается, `start_time == anchor_time`.
- Первый таск дня: ранний anchor (<07:00) → первым; иначе ближайший к home base.
- `morning_commute` / `end_of_day_commute` — не считаются рабочим временем; межзадачные переезды — считаются.
- День: ≤480 мин normal; 481–600 overtime_8_to_10; >600 overtime_over_10.
- Каждый таск ровно один раз, под своей бригадой; ID и длительности не меняются.

---

## 2. Task Planner main flow — `p3uLQZZwWGbTIic6` (inactive)

Старая версия прод-флоу. Тот же webhook-путь `d3dfcd18…`. Отличия от #1:
- помимо Supabase использовал **Airtable** (`Create a record` / `Update record`);
- набор агентов: `Assignet tasks Agent`, `Other tasks Agent`, `Unassigned Tasks with skills`;
- логически идентичный конвейер (filter unavailable → filter unassigned → skills → matching → route builder → inserter).

По сути предшественник #1; оставлен как история.

---

## 3. Task Planner -  main flow test — `lvUAxW5QbwT3lOBH` (inactive)

Тестовая версия планировщика. Webhook-путь `d3dfcd18…` (совпадает с прод —
поэтому одновременно активен может быть только один).
- Модели: **claude-sonnet-4-20250514** (skills-агент) + **gpt-5** (route-агенты).
- Хранилище — только **Supabase** `AI_teams_schedule` (без Airtable).
- Содержит полные системные промпты обоих route-агентов (см. их в JSON ноды
  `Assignet tasks Agent` и `Other tasks Agent`) — удобный референс логики.

---

## 4. Task Planner -  sender ( slack ) — `aa6XaAQ6xuLEZRcz` (inactive)

Webhook: `POST /webhook/67341a95-2c54-4154-b7cc-ca6f2af0077e`

Принимает готовое расписание и рассылает в Slack.
```
Webhook → Code - general schedule  → Send a message (канал test-bot-helper C09K2FC527M)
        → Code - separate schedule → Send a message3 (DM)
        → Respond to Webhook
```
- `Code - general schedule` — собирает единый текст по всем бригадам:
  `*Schedule for <date>*`, время жирным, адрес → Google Maps-ссылка, travel time.
- `Code - separate schedule` — персональные сообщения: маппинг
  **`TEAM_TO_USER` захардкожен** (`Gheorghe Caminschi → U0988MNV954`, остальные
  `UXXXXXXXX` — заглушки).

---

## 5. Task Planner  - sender to slack  test — `9MFaoXbtsU5SwvzB` (inactive)

Тестовый рассыльщик, тот же webhook `67341a95…`. Более новая логика:
- Slack user_id берётся **из входных полей** (`slack_user_id`/`slack_id`/
  `slack.user_id`), поддерживает форматы `<@U123>`, `@U123`, `U123` —
  без хардкода.
- Поддержка project channel id (`<#C…>`), баннер `*THIS IS ONLY A TEST !!!*`,
  `unfurlLinks/Media:false`.
- Каналы: `test-scheduler` (C09K1PX0XLH), `test-bot-helper` (C09K2FC527M).

> Рекомендация: перенести подход с `slack_user_id` из payload (#5) в прод-рассыльщик #4 вместо хардкода `TEAM_TO_USER`.

---

## Схема связей (предполагаемая, оркестрация внешняя)

```
[iOS app / бэкенд / Make]
        │  POST tasks+teams
        ▼
  Планировщик  d3dfcd18…  (#1 active)
        │  schedule JSON  (+ Supabase AI_teams_schedule)
        ▼
[оркестратор берёт результат]
        │  POST teams+tasks
        ▼
  Рассыльщик   67341a95…  (#4/#5)
        │
        ▼
     Slack (каналы + личка бригад)
```

**Не подтверждено:** кто именно дергает оба webhook и передаёт результат
планировщика в рассыльщик (внутри n8n прямой связи между группами нет).
