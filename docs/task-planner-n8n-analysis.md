# Task Planner — анализ n8n-воркфлоу

Проект-песочница для разбора группы воркфлоу **Task Planner** в n8n
(`basementremodeling.app.n8n.cloud`). Система строит дневное расписание/маршруты
для бригад (construction/remodeling, регион DC/MD/VA) и рассылает его в Slack.

> Источник: MCP-сервер `n8n-mcp`. Срез на 2026-06-15.
> Подробный поузловой разбор — в [`analysis.md`](./analysis.md).

> **✅ Выбран для работы:** воркфлоу **`cit7Gah53xPLLbdy`** (прод). Полный разбор,
> баги и план — в [`cit7-prod-analysis.md`](./cit7-prod-analysis.md). Остальные
> воркфлоу — кандидаты в архив.
>
> **Факт по executions (2026-06-15):** ни один из 5 воркфлоу Task Planner в
> сохранённой истории n8n **никогда не запускался** — система ещё не в боевой
> эксплуатации. Поэтому «самый рабочий» выбран по свежести/чистоте кода, а не по
> прогонам.

## Связанные воркфлоу (5 шт.)

| # | Воркфлоу | ID | Активен | Webhook | Роль |
|---|----------|----|---------|---------|------|
| 1 | **Task Planner ( need to check )** | `cit7Gah53xPLLbdy` | ✅ да | `/webhook/d3dfcd18…` | **ПРОД** — основной планировщик |
| 2 | Task Planner main flow | `p3uLQZZwWGbTIic6` | ❌ нет | `/webhook/d3dfcd18…` | старая версия планировщика (Airtable+Supabase) |
| 3 | Task Planner -  main flow test | `lvUAxW5QbwT3lOBH` | ❌ нет | `/webhook/d3dfcd18…` | тестовая версия планировщика |
| 4 | Task Planner -  sender ( slack ) | `aa6XaAQ6xuLEZRcz` | ❌ нет | `/webhook/67341a95…` | рассылка расписания в Slack |
| 5 | Task Planner  - sender to slack  test | `9MFaoXbtsU5SwvzB` | ❌ нет | `/webhook/67341a95…` | тестовая версия рассыльщика |

Две функциональные группы с **разными webhook**:

- **Планировщик** (`d3dfcd18…`) — 3 варианта (#1–#3). Прод — это #1.
- **Рассыльщик в Slack** (`67341a95…`) — 2 варианта (#4–#5).

Внутри n8n группы напрямую не связаны — оркестрация внешняя (бэкенд/Make
вызывает сначала планировщик, потом рассыльщик).

## Конвейер планировщика (#1, прод)

```
Webhook (POST)
  → Create a row1 (Supabase: AI_teams_schedule, сохранить input)
  → filter unavailable      [Code]  — убрать недоступные бригады
  → filter unassigned tasks [Code]  — разделить на assigned / unassigned
  → Edit Fields1
  → Unassigned Tasks with skills [AI Agent] — проставить skills задачам по описанию
  → Fields
  → unassigned tasks with optional teams [Code] — сматчить задачи↔бригады по skills
  → Assigned tasks Agent1 [AI Agent]  — построить маршруты для уже назначенных бригад
  → Other tasks Agent1   [AI Agent]  — вставить нераспределённые задачи в расписание
  → Code in JavaScript               — слить комментарии AI + вернуть skills в schedule
  → Edit Fields3 → Update a row (Supabase: записать результат)
Параллельно (сразу после Edit Fields2): Edit Fields → Respond to Webhook
```

⚠️ **Асинхронность:** ответ вебхука — это мгновенный ack `{request_ID, prompts}`,
**не расписание**. Готовый результат пишется только в Supabase `AI_teams_schedule.
output_data` по `request_ID` — потребитель должен его поллить. Детали в
[`cit7-prod-analysis.md`](./cit7-prod-analysis.md).

### Модели (прод #1)
- **Anthropic** `claude-opus-4-5-20251101` — на двух AI-агентах
- **OpenAI** `gpt-5` — на агентах; `gpt-4` на одном
- (в тест-версии #3 — `claude-sonnet-4` + `gpt-5`)

### Хранилище
- **Supabase**, таблица `AI_teams_schedule` (`input_body`, `output_data`,
  `request_ID`). В старой версии #2 дополнительно был **Airtable**.
- **Twilio** — SMS-уведомление о завершении (в прод-версии присутствует нода).

## Рассыльщик в Slack (#4 / #5)

Принимает готовый `{ teams: [{ team_name, tasks:[…] }] }`, форматирует
Slack-mrkdwn (время жирным, адрес → ссылка на Google Maps, travel time) и шлёт:

- **общее расписание** → канал (`test-scheduler` / `test-bot-helper`);
- **персональное** расписание каждой бригаде в **личку** по Slack user_id.

В #4 маппинг `team_name → Slack user_id` **захардкожен** (`TEAM_TO_USER`),
причём заполнен только один реальный id (`U0988MNV954`, Gheorghe Caminschi),
остальные — заглушки `UXXXXXXXX`. В #5 (test) id берётся из входных полей
(`slack_user_id`/`slack_id`) — это более новый и гибкий подход.

## Ключевые наблюдения / риски

1. **Прод называется «( need to check )»** и помечен активным — техдолг,
   стоит переименовать после валидации.
2. **Три почти одинаковых main flow** на одном webhook-пути `d3dfcd18…` —
   только один активен; дубли стоит заархивировать во избежание путаницы.
3. **Хардкод Slack-id** в #4 — рабочая рассылка по личкам сейчас возможна
   только одной бригаде. Логику #5 (id из payload) надо перенести в прод.
4. **Связь планировщик ↔ рассыльщик не видна внутри n8n** — нужно
   подтвердить, кто вызывает webhook `67341a95…` (бэкенд iOS-app / Make).
