# Task Planner (cit7) — полный разбор выбранного прод-воркфлоу

> **Выбранный для работы воркфлоу.** Остальные (`p3uL` main flow, `lvUAx` test,
> рассыльщики) — кандидаты в архив. Обзор группы — [`README.md`](./README.md),
> сравнение версий — [`analysis.md`](./analysis.md).

- **Имя:** `Task Planner ( need to check )` — нужно переименовать
- **ID:** `cit7Gah53xPLLbdy`
- **Статус:** active
- **Webhook:** `POST /webhook/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27` (responseMode: responseNode)
- **Срез:** 2026-06-15. Executions: **0** (в сохранённой истории воркфлоу
  никогда не запускался — система ещё не в боевой эксплуатации).

---

## 1. Архитектура: асинхронный, ответ ≠ результат

Сразу после приёма поток **раздваивается** (`Edit Fields2` → два выхода):

```
Webhook
  └─ Edit Fields2 ─┬─→ Edit Fields ─→ Respond to Webhook   ← МГНОВЕННЫЙ ACK
                   │      (отдаёт только {request_ID, Persistent/One-time Prompt})
                   │
                   └─→ Create a row1 (Supabase insert input)
                          └─→ filter unavailable
                                └─→ filter unassigned tasks
                                      └─→ Edit Fields1
                                            └─→ Unassigned Tasks with skills [AI]
                                                  └─→ Fields
                                                        └─→ unassigned tasks with optional teams
                                                              └─→ Assigned tasks Agent1 [AI]
                                                                    └─→ Other tasks Agent1 [AI]
                                                                          └─→ Code in JavaScript
                                                                                └─→ Edit Fields3
                                                                                      └─→ Update a row (Supabase update)  ← РЕАЛЬНЫЙ РЕЗУЛЬТАТ
```

**Вывод:** HTTP-ответ вебхука — это ack, а не расписание. Готовое расписание
кладётся **только в Supabase** `AI_teams_schedule.output_data` по `request_ID`.
Потребитель (iOS-app / бэкенд) должен **поллить Supabase** по `request_ID`.

---

## 2. Входной payload (body вебхука)

```
{
  request_ID,
  "Persistent Prompt",   // постоянный frontend-оверрайд
  "One-time Prompt",     // разовый frontend-оверрайд
  tasks: [ {
    id, description, estimated_duration (часы), priority,
    scheduled_date, scheduled_time:{ type:"exact"|"timeframe", start, end },
    project:{ project_id, project_name, project_address, project_latitude, project_longitude },
    team: {…}|null        // null/пусто = задача НЕ назначена
  } ],
  Teams: [ { team_name, team_address, team_latitude, team_longitude, skills:[…] } ],
  "Unavailable teams": [ { team_name } ],
  Skills: [ … ]           // библиотека допустимых скиллов
}
```

---

## 3. Пошаговый конвейер и контракты данных

| # | Узел | Тип / модель | Вход → Выход |
|---|------|-------------|--------------|
| 1 | Webhook | webhook | приём POST |
| 2 | Create a row1 | Supabase insert | `input_body` + `request_ID` в `AI_teams_schedule` |
| 3 | Edit Fields2 | Set | вытащить `Teams`, `UnavailableTeams`, `tasks`, `request_ID` из body |
| 4 | filter unavailable | Code | по имени (NFKC-нормализация) убрать недоступные бригады → `Teams`, `ExcludedTeams` |
| 5 | filter unassigned tasks | Code | делит `tasks` на `assigned`/`unassigned` (по наличию `team`); считает часы; группирует `assigned_by_team`; сортирует задачи по «весу времени» (exact=0, timeframe=1, none=3), затем priority, затем длительность |
| 6 | Edit Fields1 | Set | собрать переменные: `unassigned tasks`, `assigned tasks`, `available teams`, `skills` |
| 7 | Unassigned Tasks with skills | **AI agent (gpt-4)** | каждой нераспределённой задаче проставить `skills:[{name}]` из библиотеки → `output.tasks_with_skills`, `output.meta.notes` |
| 8 | Fields | Set | `tasks_with_skills`, `available_teams`, `frontend overrides` (склейка Persistent+One-time) |
| 9 | unassigned tasks with optional teams | Code | матчинг по скиллам: для каждой задачи `optional_team[]` (бригады, чьи skills ⊇ skills задачи); зеркально `teams_with_optional_tasks[]` |
| 10 | Assigned tasks Agent1 | **AI agent (gpt-5)** | ROUTE & DAILY SCHEDULE BUILDER: для уже **назначенных** задач строит дневные маршруты/таймлайны (anchors, drive time, overtime) → `output.schedule[]` + `output.comments{}` |
| 11 | Other tasks Agent1 | **AI agent (claude-opus-4-5)** | ASSIGNMENT & ROUTE INSERTER: вставляет **нераспределённые** задачи в готовое расписание (жёсткий no-reschedule) → обновлённый `output.schedule` + `output.comments{inserted, unscheduled}` |
| 12 | Code in JavaScript | Code | сливает comments обоих агентов в `commentsAI-1`/`commentsAI-2`, удаляет `output.comments` |
| 13 | Edit Fields3 | Set | `Other tasks Agent = $json.output` (финальное расписание) |
| 14 | Update a row | Supabase update | `output_data = {{Other tasks Agent}}` по `request_ID` |

Параллельная ветка-ack: `Edit Fields` (request_ID + prompts) → `Respond to Webhook`.

---

## 4. Модели и привязка

| AI-агент | Модель-нода | Модель |
|----------|-------------|--------|
| Unassigned Tasks with skills | OpenAI Chat Model2 | **gpt-4** |
| Assigned tasks Agent1 (route builder) | OpenAI Chat Model | **gpt-5** |
| Other tasks Agent1 (inserter) | Anthropic Chat Model2 | **claude-opus-4-5-20251101** |

Парсеры: Parser1→skills, Parser2→route builder, Parser3→inserter.

---

## 5. Логика AI-агентов (суть промптов)

**Skills tagger (gpt-4):** только проставляет `skills` из библиотеки, не выдумывает,
не меняет остальные поля. Каждая задача обязана получить ≥1 скилл.

**Route builder (gpt-5), детерминизм temp=0:**
- Anchor = `scheduled_time.type=="exact"`, неподвижен, `start_time==anchor_time`, не перекрывается.
- Первый таск: ранний anchor (<07:00) → первым; иначе ближайший к home base.
- Drive time — «реалистичный route-based для DC/MD/VA», **без матрицы расстояний** (оценка моделью).
- `morning/end_of_day_commute` — не рабочее время; межзадачные переезды — рабочее.
- День: ≤480 normal / 481–600 overtime_8_to_10 / >600 overtime_over_10.
- Каждый таск ровно один раз под своей бригадой; ID/длительности не меняются.
- Жёсткий self-validation gate перед выводом.

**Inserter (opus-4-5), детерминизм temp=0:**
- **NO RESCHEDULING:** не двигать/менять/удалять существующие задачи. Вставка только
  в свободный зазор, в конец дня, или первой если у бригады пусто.
- Скоринг: `added_drive + 30*overtime_h + 200*is_over_10h - 2*priority`.
- Не влезло без нарушений → в `comments.unscheduled` с причиной.
- (Подробности про жёсткий vs гибкий вариант — в [`analysis.md`](./analysis.md).)

---

## 6. ⚠️ Слабые места, баги и непонятное

### Баги (подтверждённые из кода)

1. **🔴 `Code in JavaScript` теряет comments первого агента.**
   Внутри: `$items('Assigned tasks Agent', 0, 0)` — но нода называется
   **`Assigned tasks Agent1`** (с суффиксом «1»). Имя не совпадает → `comments1`
   всегда `{}` → `commentsAI-1` (anchor_conflicts_resolved, first_task_rationale,
   overtime_notes от route builder) **молча теряется** в финальном выводе.
   *Фикс:* `$items('Assigned tasks Agent1', 0, 0)`.

2. **🟠 Twilio SMS — мёртвая нода.** `Send an SMS/MMS/WhatsApp message`
   (to `+14432240484`, from `+13013296226`) **не подключена** ни к одному выходу.
   Уведомление о завершении не отправляется. Либо подключить, либо удалить.

3. **🟠 Две висячие модель-ноды.** `OpenAI Chat Model1` (gpt-5) и
   `Anthropic Chat Model1` (opus-4-5) ни к чему не подключены — остатки
   экспериментов. Удалить, чтобы не путали.

### Расхождения / латентные проблемы

4. **🟡 Опечатка в поле `optional_teamlatitude`** (нет подчёркивания) в выводе
   `unassigned tasks with optional teams`. Inserter-промпт latitude не читает,
   поэтому пока без эффекта — но это латентный баг при будущем использовании гео.

5. **🟡 `assigned_by_team` вычисляется, но не используется.** Нода
   `filter unassigned tasks` строит группировку, а route builder читает сырой
   `.assigned`. Лишняя работа (не вредит, но мусор).

6. **🟡 Parser2 (route builder) в схеме-примере без ключа `overtime`,** хотя
   промпт требует `overtime` в каждом team-объекте (Parser3 его имеет). Рассинхрон
   схемы и промпта; на example-схему модель опирается слабо, но лучше выровнять.

7. **🟡 `teamMeta` непоследователен:** ветка без команды отдаёт `address`, обычная —
   `team_address`. Косметика, downstream это поле не берёт.

### Концептуальные риски

8. **🟠 Drive time без матрицы расстояний.** Оба route-агента «оценивают
   реалистичное время в пути для DC/MD/VA» исключительно из знаний LLM. Точность
   и детерминизм под вопросом — это сердце планирования. Кандидат на интеграцию
   реального ETA-провайдера (Google Distance Matrix и т.п.).

9. **🟠 Нет ретраев на агентах.** В тест-версии `lvUAx` route-агенты обёрнуты в
   `onError: continueErrorOutput` + `maxTries: 5`; здесь — нет. Сбой LLM роняет весь
   прогон. Перенести обвязку из `lvUAx`.

10. **🟡 Имя `( need to check )`** у активного прод-воркфлоу — техдолг, переименовать.

### Непонятное (требует executions / уточнения)

11. **Кто и как поллит Supabase** за результатом по `request_ID` — внутри n8n не
    видно, оркестрация внешняя. Связь с рассыльщиком (`67341a95…`) тоже внешняя.
12. **Реальный формат `tasks`/`Teams`/`Skills`** из iOS-app — проверяется только
    на живых прогонах (executions сейчас пустые).
13. **Доезжает ли `frontend overrides`** до агентов и как влияет — без прогонов
    не подтверждается.

---

## 7. Рекомендованный план приведения в порядок

1. Переименовать воркфлоу (убрать «( need to check )»).
2. Фикс бага #1 (`Assigned tasks Agent1` в `Code in JavaScript`).
3. Решить судьбу Twilio (#2): подключить или удалить.
4. Удалить висячие модель-ноды (#3).
5. Перенести ретраи агентов из `lvUAx` (#9).
6. По результатам первых executions — решить про гибкий inserter (no-reschedule).
7. После — архивировать `p3uL` и `lvUAx`.
