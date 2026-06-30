# AI-MODULES — пайплайн планировщика n8n (детальный разбор для дебага)

> Назначение: по каждому модулю — что делает, как настроен, вход/выход, где
> недетерминизм и как дебажить. Чтобы сложный ИИ-пайплайн перестал работать «неочевидно».
> Воркфлоу `cit7Gah53xPLLbdy` «Task Planner». Срез: 2026-06-24 (по экспорту t3d).
> Связано с [`SPEC.md`](SPEC.md) (§6–§7). Обновлять при правках нод.

---

## 0. Карта пайплайна (поток)

```
Webhook → Edit Fields2 ─┬─ Edit Fields → Respond to Webhook            (мгновенный ACK)
                        └─ Create a row1 → filter unavailable → filter unassigned tasks
                           → Edit Fields1 → [AI#1 Unassigned Tasks with skills] → Fields
                           → [МАТЧЕР unassigned tasks with optional teams]
                           → [AI#2 Assigned tasks Agent] → [AI#3 Other tasks Agent]
                           → Code in JavaScript (merge) → Edit Fields3 → Update a row (Supabase)
```

### Инвентарь нод (22 = 16 модулей основного потока + 6 сабнод)
**16 модулей основного потока:** Webhook · Edit Fields2 · Edit Fields · Respond to
Webhook · Create a row1 · filter unavailable · filter unassigned tasks · Edit Fields1 ·
**Unassigned Tasks with skills** (тег­гер) · Fields · **unassigned tasks with optional
teams** (матчер) · **Assigned tasks Agent** · **Other tasks Agent** · Code in JavaScript ·
Edit Fields3 · Update a row.
**6 сабнод** (подключены к 3 агентам): 3× OpenAI Chat Model (`ai_languageModel`) +
3× Structured Output Parser (`ai_outputParser`).

### Глоссарий
- **«тег­гер»** = нода `Unassigned Tasks with skills`. *Tags* = навешивает каждой
  задаче **скиллы** из её описания (чтобы матчер знал, какие бригады подходят).
- **«матчер»** = `unassigned tasks with optional teams` — сопоставляет задача↔бригада по скиллам.
- **AI#2 «route builder»** = `Assigned tasks Agent`; **AI#3 «inserter»** = `Other tasks Agent`.

### Симптом → где смотреть (быстрый дебаг)

| Симптом | Смотреть |
|---|---|
| `Model output doesn't fit required format` | соответствующий **Structured Output Parser** (схема) + его агент; включить Auto-Fix |
| Все задачи ушли в unscheduled | **МАТЧЕР** (`optional_team` пуст?) → скиллы команд/формат `{name,level}` |
| Пропали `priority`/`skills` у задач | **AI#1 тег­гер** + его **Parser1** (схема не carry-through) — §round-trip |
| Якорь «съехал» / ночная смена | вход: `scheduled_time` формат; **AI#2** промпт (anchor handling) |
| `comments_ai_1` пустой | `Code in JavaScript` — имя ноды в `$items('Assigned tasks Agent')` |
| Результат не появился в приложении | `Update a row` — пишет ли в ту же Supabase (`AI_teams_schedule`) |

---

## 0.5 СТАТУС 2026-06-25 — все 3 агента переведены на Code-парсинг ✅
Structured Output Parser убраны у **всех трёх** агентов; после каждого — Code-нода:
`Unassigned Tasks with skills → Parse Skills`, `Assigned tasks Agent → Parse Route`,
`Other tasks Agent → Parse Insert`. Merge-нода переименована в `Merge comments`, тянет
`$items('Parse Route')`. Падений `doesn't fit format` больше нет.
**Подтверждено полным прогоном** (req `f37c604a`, 2026-06-25): 16/16 покрытие, якоря
09/11/12 на месте, 0 перекрытий, 0 unscheduled, скиллы дошли до матчинга (3 unassigned
размещены инсертером по eligibility).

## 1. Детерминизм — общая картина

- **LLM-ноды недетерминированы.** Сейчас **все 3 агента на gpt-5**, а `gpt-5`
  **игнорирует `temperature=0`** (не поддерживает) → полной воспроизводимости нет.
- **Матчер — единственный полностью детерминированный** модуль (чистый JS).
- **Строгие Structured Output Parsers** — главный источник плавающих падений
  (`doesn't fit required format`). Лечение: Auto-Fix + модель-фиксер + смягчение схем (§SPEC 7).
- **Round-trip:** через **тег­гер (AI#1) проходят ТОЛЬКО unassigned-задачи** — там риск
  потери полей. **Assigned-задачи** `Assigned tasks Agent` берёт **напрямую** из
  `filter unassigned tasks` → их поля целы.

---

## 2. Модули по порядку

### 2.1 Webhook → Edit Fields2 (вход)
- **Тип:** webhook (POST) + Set. Не AI.
- **Делает:** принимает payload фронта, раскладывает: `Edit Fields2` →
  `Teams = body.Teams`, `UnavailableTeams = body['Unavailable teams']`,
  `tasks = body.tasks`, `request_ID = body.request_ID`.
- **Ветка ACK:** `Edit Fields → Respond to Webhook` отвечает фронту сразу (НЕ расписанием).
- **Дебаг:** открыть Webhook → Output: пришли ли `tasks`, `Teams`, `Skills`, формат
  `scheduled_time` у задач (`{type:'exact', time}` — §SPEC 5.1).

### 2.2 Create a row1 (Supabase)
- **Делает:** создаёт строку в `AI_teams_schedule` с `request_ID` + `input_tasks` (снимок входа).
- **Важно:** именно сюда фронт потом обращается за результатом. `onError: continueRegularOutput`.
- **Дебаг:** если строки нет — кнопка «Подтянуть» во фронте ничего не найдёт.

### 2.3 filter unavailable (Code, детерминирован)
- **Делает:** убирает недоступные бригады: `Teams` минус `UnavailableTeams` (по
  нормализованному имени). Выдаёт `Teams` (доступные) + `ExcludedTeams`.
- **Дебаг:** проверить, что нужные бригады не отфильтровались из-за расхождения имён.

### 2.4 filter unassigned tasks (Code, детерминирован)
- **Делает:** делит задачи на `assigned` (есть `team`) и `unassigned`; группирует
  assigned по бригадам; считает часы. **Ключ round-trip:** `assigned` дальше идут
  В ОБХОД тег­гера (поля целы).
- **Дебаг:** счётчики `counts {assigned, unassigned}`. Если задача с командой попала в
  unassigned — смотреть `hasTeam()` (форма `team`).

### 2.5 🤖 AI#1 — `Unassigned Tasks with skills` (ТЕГ­ГЕР)
- **Роль:** проставить каждой **unassigned**-задаче скиллы из её описания (для матчинга).
- **Модель:** `OpenAI Chat Model2` — **gpt-5** (cred `t3d_dev`), timeout 300s.
  ⚠️ Раньше gpt-4o; смена на gpt-5 **НЕ** убрала падения парсера — корень в строгой
  схеме, не в модели (§SPEC 7).
- **Вход:** `Edit Fields1` → промпт берёт `unassigned tasks` + `Skills`
  (`UNASSIGNED_TASKS_JSON` / `SKILLS_LIBRARY_JSON`).
- **Промпт (ключевое):** «назначь скиллы ТОЛЬКО из SKILLS; не выдумывай; **сохрани
  исходные поля задачи**, добавь `skills:[{name}]`; у каждой задачи непустой skills».
- ✅ **РЕШЕНО (2026-06-25):** Structured Output Parser УБРАН. «Require Specific Output
  Format» = OFF; агент отдаёт **обычный текст** — минимальный JSON `[{id, skills:[…]}]`.
  Парсинг и целостность — в Code-ноде **`Parse Skills`** (см. 2.6). Падений
  `doesn't fit required format` больше нет (валидатора нет). Модель — любая (gpt-5/4o).
- **Дебаг:** Output агента = строка JSON; саму раскладку смотреть в `Parse Skills`.

### 2.6 `Parse Skills` (Code-нода — заменила Structured Output Parser1) ✅
- **Делает:** берёт текст агента (`$json.output`), защитно парсит (снимает ```-обёртки,
  `JSON.parse` с try/catch), нормализует skills (string→`{name}`), и **прицепляет скиллы
  к ОРИГИНАЛЬНЫМ unassigned-задачам** из `filter unassigned tasks` по `id`.
- **Выход:** всегда одинаковая форма `{ output: { tasks_with_skills:[…], meta:{notes} } }`
  (downstream `Fields` не менялся). Если у задачи нет скиллов — `meta.notes` сигналит,
  но нода НЕ падает.
- ✅ **Round-trip гарантирован кодом** (поля из оригинала, не из вывода LLM).
- **Старый `Structured Output Parser1` + autofix-модель удалены** (были источником
  плавающих падений).

### 2.7 Fields (мост тег­гер → матчер)
- **Делает (Set):** `tasks_with_skills = $json.output.tasks_with_skills`;
  `available_teams = filter unavailable.Teams`; `assigned tasks = filter…assigned`;
  `frontend overrides` = persistent/one-time prompt.
- 🔴 **Точка потери полей:** дальше по `tasks_with_skills` идёт только то, что вернул
  тег­гер. Если поле пропало здесь — корень в Parser1.

### 2.8 ⚙️ МАТЧЕР — `unassigned tasks with optional teams` (Code, ДЕТЕРМИНИРОВАН)
- **Роль:** для каждой unassigned-задачи найти подходящие бригады по скиллам, **с
  учётом уровня** (level 1 = высший); отсортировать «лучшие первыми».
- **Вход:** `Fields` → `tasks_with_skills` + `available_teams` (скиллы команд `{name,level}`).
- **Логика:** нормализует имена скиллов (срезает «- N»); строит `Map(имя→мин.уровень)`
  по командам; задача подходит команде, если та умеет ВСЕ требуемые скиллы; добавляет
  `optional_team` со `optional_team_level`; сортирует по уровню.
- **Выход:** `tasks_with_optional_teams` (+ `teams_with_optional_tasks`).
- ✅ **Версия с уровнями (Change 2) уже применена** на t3d (и basement). Старый матчер
  (`Set` строк) ломался на объектах `{name,level}` → «[object object]» → ноль матчей.
- **Дебаг:** Output → у задач непустой `optional_team`? стоит `optional_team_level`?
  Если пусто — расхождение имён скиллов задача↔команда.

### 2.9 🤖 AI#2 — `Assigned tasks Agent` (ROUTE BUILDER / маршруты)
- **Роль:** построить дневные маршруты/времена для **уже назначенных** задач (по бригадам),
  с учётом якорей и реалистичного драйва.
- **Модель:** `OpenAI Chat Model` — **gpt-5** (cred `lucky_day`), timeout 300s.
- **Вход:** напрямую `$('filter unassigned tasks').item.json.assigned` (поля целы) +
  `frontend overrides`.
- **Промпт (ключевое):** anchors immutable (`scheduled_time.type=='exact'` → `start ==
  time`); первый таск по якорю/ближайшему к дому; драйв реалистичный DC/MD/VA; день
  ≤480 normal / 481–600 / >600; output schedule[] + comments.
- **Выход → Structured Output Parser2:** `{ schedule:[TeamDay{team_id,…,tasks:[{scheduled_order,
  task_id, project_*, anchor, anchor_time, start_time, end_time, duration_minutes,
  drive_minutes_from_previous}], summary}], comments:{anchor_conflicts_resolved[], …} }`.
- **Недетерминизм:** gpt-5 (temp≠0), драйв «на глаз» (без матрицы) → времена плавают.
- **Дебаг:** якорь `start_time == anchor_time`? `anchor_conflicts_resolved` непустой при якорях?

### 2.10 🤖 AI#3 — `Other tasks Agent` (INSERTER / вставка unassigned)
- **Роль:** вставить **unassigned**-задачи в расписание из AI#2, выбрав команду из
  `optional_team` (с учётом `optional_team_level` — Change 3), не ломая якоря.
- **Модель:** `OpenAI Chat Model1` — **gpt-5** (cred `lucky_day`), timeout 300s.
- **Имя ноды:** ⚠️ basement = `Other tasks Agent1`, t3d = `Other tasks Agent`.
- **Вход:** `schedule` от AI#2 (`$json.output.schedule`) + `tasks_with_optional_teams`
  от матчера + `frontend overrides`.
- **Промпт (ключевое):** каждый unassigned с ≥1 eligible-командой ДОЛЖЕН быть размещён;
  можно двигать non-anchor, нельзя двигать якоря/создавать перекрытия; **SKILL-LEVEL
  PRIORITY** (меньший `optional_team_level` лучше); scoring-формула; иначе → unscheduled с причиной.
- ✅ **Промпт с уровнями (Change 3) уже применён** на t3d (3 вставки: INPUT, SKILL-LEVEL
  PRIORITY, обновлённый score).
- **Выход → Structured Output Parser3:** `{ schedule[], comments:{ inserted[], unscheduled[], … } }`.
- **Недетерминизм:** gpt-5; выбор команды зависит от формулы score + драйва «на глаз».
- **Дебаг:** `comments.unscheduled` (почему не вставил), у вставленных — правильная ли
  команда по уровню.

### 2.11 Code in JavaScript (merge комментариев, детерминирован)
- **Делает:** собирает `commentsAI-1` (из `Assigned tasks Agent`) и `commentsAI-2` (из
  текущего входа = AI#3) в `output`; удаляет `output.comments`.
- ⚠️ **Баг-риск:** `$items('Assigned tasks Agent', …)` — имя должно ТОЧНО совпадать с
  нодой AI#2 (на t3d совпадает; на старом basement было `Assigned tasks Agent1` → терялось).
- **Дебаг:** если `commentsAI-1` пуст — проверить имя ноды в коде.

### 2.12 Edit Fields3 → Update a row (Supabase)
- **Делает:** `Edit Fields3` кладёт `$json.output` в поле `Other tasks Agent`;
  `Update a row` пишет его в `AI_teams_schedule.output_data` по `request_ID`.
- 🔴 **Критично:** кред Supabase должен указывать на **ту же базу**, что читает фронт
  (`dhtewaqfcsejdllwhgtl`) — иначе результат не виден (§SPEC 2).
- **Дебаг:** появилось ли `output_data.schedule` в строке прогона.

---

## 3. Приоритетные фиксы (детерминизм/надёжность)

1. ✅ **Тег­гер — СДЕЛАНО (2026-06-25):** Structured Output Parser убран; агент отдаёт
   `[{id, skills}]` текстом; Code-нода `Parse Skills` парсит и прицепляет скиллы к
   оригиналам. Падений `doesn't fit format` больше нет. (Подтверждено прогоном.)
2. 🟢 **Round-trip — закрывается тем же:** Code-нода берёт поля из оригинала, а не из
   вывода LLM, поэтому ничего не теряется (§SPEC 5.7).
3. 🟠 **Ретраи** на всех 3 агентах (`retryOnFail`, maxTries 2–3) + retry на Supabase-нодах.
4. 🟠 **SMS-нода** (оживить Twilio) в конец после `Update a row` — оповещение «готово».
5. 🟡 **Драйв без матрицы** (AI#2/AI#3 оценивают «на глаз») — источник плавающих времён;
   реальный travel считает фронт (Google), §SPEC 5.4.
6. 🟡 **Детерминизм моделей:** все 3 агента на gpt-5 (temp=0 недоступен) → времена
   плавают. Если нужна воспроизводимость — рассмотреть gpt-4o с temp=0 на отдельных нодах.

## 4. Чек-лист «прогон прошёл корректно»
- [ ] Тег­гер не упал; у unassigned появились `skills`.
- [ ] Матчер: у задач непустой `optional_team` + `optional_team_level`.
- [ ] Каждое входное `task_id` есть в выходе ровно раз (или в `unscheduled` с причиной).
- [ ] Якоря: `start_time == anchor_time`, нет перекрытий.
- [ ] Поля `priority`/`skills`/прочее не потерялись (round-trip).
- [ ] `output_data.schedule` записан в `AI_teams_schedule` (та же Supabase, что у фронта).
