# n8n-правки: скилл-матчинг с учётом уровня

**Дата:** 2026-06-22 (план) → 2026-06-23 (применено). **Воркфлоу:** `cit7Gah53xPLLbdy` «Task Planner».

## СТАТУС 2026-06-23
- ✅ **basementremodeling (прод)** — Change 2 (матчер) + Change 3 (промпт `Other tasks Agent1`)
  применены через n8n MCP и проверены diff'ом. MCP `.mcp.json` смотрит на этот инстанс.
  Прод-webhook планировщика тоже здесь (`/webhook/d3dfcd18`).
- ✅ **t3d-projects (тест)** — готов пропатченный экспорт `taskplanner/t3d-planner.patched.json`
  (импортировать обратно в воркфлоу). Здесь AI-нода называется **`Other tasks Agent`** (БЕЗ единицы),
  матчер — `unassigned tasks with optional teams`. Патч сверен с эталонами basement (current==old).
  - Альтернатива ручной вставки: матчер ← `taskplanner/n8n-matcher.applied.js`;
    агент `Other tasks Agent` ← `taskplanner/n8n-other-tasks-agent.prompt.txt` (с ведущим `=`).
- ⚠️ Имя AI-ноды РАЗНОЕ по инстансам: basement = `Other tasks Agent1`, t3d-projects = `Other tasks Agent`.

**Тест-webhook:** `t3d-projects.app.n8n.cloud/webhook-test/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27`.

## Контекст / где остановились
- Фронт уже шлёт `team.skills` как `[{ name, level }]` (level 1 = высший приоритет).
- В пайплайне планировщика **матчер по скиллам** = Code-нода
  `unassigned tasks with optional teams`; выбор команды среди подходящих делает
  AI-нода `Other tasks Agent`.
- ⚠️ КРИТИЧНО: текущий матчер ждёт `team.skills` как **массив строк**
  (`(t.skills||[]).map(normSkillName)`), а фронт теперь шлёт **объекты** `{name, level}`
  → `normSkillName(объект)` = `"[object object]"` → ноль матчей → все задачи в unscheduled.
  Поэтому матчер ОБЯЗАТЕЛЬНО обновить (Change 2 ниже).

## Поток пайплайна (для ориентира)
Webhook → Edit Fields2 → (Edit Fields→Respond ack) + Create a row1 → filter unavailable
→ filter unassigned tasks (split assigned/unassigned) → Edit Fields1
→ **Unassigned Tasks with skills** (тег­гер, gpt-4o, Parser1) → Fields
→ **unassigned tasks with optional teams** (МАТЧЕР) → **Assigned tasks Agent** (маршруты по уже назначенным)
→ **Other tasks Agent** (вставка unassigned, выбор optional_team) → Code in JavaScript (merge comments)
→ Edit Fields3 → Update a row.

---

## Change 1 — нода `Unassigned Tasks with skills` (тег­гер) — УЖЕ СДЕЛАНО
- `OpenAI Chat Model2` = **gpt-4o** ✅
- `Structured Output Parser1` = relaxed JSON Schema (required только `id`+`skills`) ✅
- Опц.: включить тумблер **Auto-Fix Format** на Parser1 (страховка).

---

## Change 2 — нода `unassigned tasks with optional teams` (МАТЧЕР) — ✅ ПРОД / ⏳ t3d-projects
Готовый код: `taskplanner/n8n-matcher.applied.js`. Открыть ноду → Parameters → поле JavaScript → ЗАМЕНИТЬ ВЕСЬ КОД на:

```js
// === MATCHER: задача ↔ команда по скиллам, с учётом УРОВНЯ (level 1 = высший) ===
function normSkillName(s) {
  return String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim()
    .replace(/\s*-\s*\d+$/, "").toLowerCase(); // срезаем "- N" для сравнения по имени
}
function normText(s) { return String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim(); }
function toNumOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x); return Number.isFinite(n) ? n : null;
}
// скилл может прийти как {name, level} (новый фронт) или "Name - 2" (старый) → {name, level}
function parseTeamSkill(s) {
  if (s && typeof s === "object") return { name: normSkillName(s.name), level: toNumOrNull(s.level) };
  const raw = String(s || ""); const m = raw.match(/-\s*(\d+)\s*$/);
  return { name: normSkillName(raw), level: m ? Number(m[1]) : null };
}

const src = ($input.first()?.json) || {};
const tasks = Array.isArray(src.tasks_with_skills) ? src.tasks_with_skills
  : (Array.isArray(src["unassigned tasks"]) ? src["unassigned tasks"] : []);
const available_teams = Array.isArray(src.available_teams) ? src.available_teams
  : (Array.isArray(src.Teams) ? src.Teams : []);

const teamSkillMap = available_teams.map(t => {
  const team_name = normText(t.team_name ?? t.nameCrew ?? t.name ?? "");
  const address   = t.team_address ?? t.address ?? "";
  const latitude  = toNumOrNull(t.team_latitude ?? t.latitude ?? t.lat);
  const longitude = toNumOrNull(t.team_longitude ?? t.longitude ?? t.lon);
  const skillLevels = new Map(); // нормализованное имя -> лучший (минимальный) уровень
  for (const sk of (t.skills || [])) {
    const { name, level } = parseTeamSkill(sk);
    if (!name) continue;
    if (!skillLevels.has(name)) skillLevels.set(name, level);
    else { const prev = skillLevels.get(name); if (level != null && (prev == null || level < prev)) skillLevels.set(name, level); }
  }
  return { name: team_name, team_name, address, latitude, longitude, skillLevels, raw: t };
});

const taskReqCache = new Map();
function requiredSkillsOfTask(task) {
  if (taskReqCache.has(task)) return taskReqCache.get(task);
  const required = (task.skills || []).map(s => normSkillName(s?.name ?? s)).filter(Boolean);
  taskReqCache.set(task, required); return required;
}
function canTeamDoTask(team, task) {
  const required = requiredSkillsOfTask(task);
  if (!required.length) return false;
  return required.every(r => team.skillLevels.has(r));
}
// эффективный уровень команды для задачи = худший (макс. номер) среди требуемых скиллов
function teamLevelForTask(team, task) {
  let worst = null;
  for (const r of requiredSkillsOfTask(task)) {
    const lv = team.skillLevels.get(r);
    if (lv == null) continue;
    worst = (worst == null) ? lv : Math.max(worst, lv);
  }
  return worst; // null = уровень неизвестен
}
function pickTaskGeo(t) {
  const p = t.project || {};
  return { address: p.project_address ?? p.address ?? t.address ?? null,
    latitude: toNumOrNull(p.project_latitude ?? t.latitude),
    longitude: toNumOrNull(p.project_longitude ?? t.longitude) };
}
function findEligibleTeams(task) {
  const matches = [];
  for (const team of teamSkillMap) {
    if (canTeamDoTask(team, task)) matches.push({
      optional_team_name: team.name, optional_team_address: team.address,
      optional_teamlatitude: team.latitude, optional_team_longitude: team.longitude,
      optional_team_level: teamLevelForTask(team, task), // 1 = высший приоритет
    });
  }
  return matches.sort((a, b) => { // уровень 1 первым, null в конец, затем по имени
    const la = a.optional_team_level == null ? Infinity : a.optional_team_level;
    const lb = b.optional_team_level == null ? Infinity : b.optional_team_level;
    if (la !== lb) return la - lb;
    return normText(a.optional_team_name).localeCompare(normText(b.optional_team_name));
  });
}
function findEligibleTasks(team) {
  const matches = [];
  for (const t of tasks) {
    if (canTeamDoTask(team, t)) {
      const geo = pickTaskGeo(t); const firstLine = String(t.description || "").split("\n")[0] || "";
      matches.push({
        optional_task_id: t.id ?? t.project?.id ?? null,
        optional_task_title: t.title ?? t["Task Title"] ?? normText(firstLine),
        optional_task_address: geo.address, optional_task_latitude: geo.latitude,
        optional_task_longitude: geo.longitude, optional_task_priority: t.priority ?? t.Priority ?? null,
        optional_task_duration: t.estimated_duration ?? t.duration ?? t.Duration ?? null,
        optional_task_level: teamLevelForTask(team, t),
      });
    }
  }
  return matches.sort((a, b) => normText(a.optional_task_title ?? "").localeCompare(normText(b.optional_task_title ?? "")));
}

const tasks_with_optional_teams = tasks.map(t => ({ ...t, optional_team: findEligibleTeams(t) }));
const teams_with_optional_tasks = teamSkillMap.map(team => ({
  name: team.name, address: team.address, latitude: team.latitude, longitude: team.longitude,
  optional_tasks: findEligibleTasks(team),
})).sort((a, b) => normText(a.name).localeCompare(normText(b.name)));

return [{ json: { tasks_with_optional_teams, teams_with_optional_tasks } }];
```

Изменения vs старый код: `Set` → `Map(имя→уровень)`; понимает `{name, level}` (и старые строки);
в каждый `optional_team` добавлен `optional_team_level`; список команд отсортирован «уровень 1 вперёд».

---

## Change 3 — нода `Other tasks Agent1` (промпт) — ✅ ПРОД / ⏳ t3d-projects — 3 вставки
Готовый итоговый промпт целиком: `taskplanner/n8n-other-tasks-agent.prompt.txt`. Ниже — что именно вставлено:

**3.1. Блок INPUT** — у строки про `optional_team:` дописать:
```
optional_team: [{ "optional_team_name", "optional_team_address", "optional_team_level" }, ...]
— map by exact team_name in schedule; ignore names not found.
optional_team_level: skill level of that team for THIS task (1 = most qualified, lower is better; null = unknown).
The optional_team array is PRE-SORTED best-first by optional_team_level.
```

**3.2. Блок ASSIGNMENT RULES** — добавить правило:
```
SKILL-LEVEL PRIORITY:
Among eligible teams for a task, prefer the one with the LOWEST optional_team_level (1 = highest skill).
This is a strong tiebreaker: apply it AFTER anchors / feasibility / overtime limits, but it OUTWEIGHS
small drive-time differences (<= 15 min). Treat null level as the worst (least preferred).
```

**3.3. Блок SCORING & CHOICE** — заменить формулу score:
```
score = added_drive_minutes
      + 25 * (optional_team_level_or_3 - 1)
      + 30 * overtime_hours_after_insertion
      + 200 * is_over_10h
      - 2 * priority
where optional_team_level_or_3 = optional_team_level if present else 3.
Tie-breakers in order: (1) lower optional_team_level, (2) no-overtime wins,
(3) lower added_drive_minutes, (4) fewer total tasks on that team, (5) shorter last_stop->T distance.
```

---

## НЕ трогаем
- Фронт — уже шлёт `{name, level}`.
- `Code in JavaScript` (merge) — `$items('Assigned tasks Agent')` совпадает с именем ноды, баг закрыт.
- `Assigned tasks Agent` — работает с уже назначенными задачами, уровень там не нужен.

## После правок — проверить
1. Прогнать тест «Send to AI», взять output.
2. Убедиться: `optional_team` наполнен, у каждого стоит `optional_team_level`, задачи не валятся в unscheduled.
3. Тест-кейс: 1 задача + 2 команды с разным уровнем одного скилла → должна выбраться level 1.

## Прочие открытые n8n-задачи (из ROADMAP)
- Merge тег­гера в `skill_requirements` — в ЭТОМ пайплайне не нужно (матчер читает `task.skills` напрямую).
- Slack: воркфлоу Disabled + `TEAM_TO_USER` placeholder (только Gheorghe).
- Решить по инстансу: если переезд на t3d-projects — обновить во фронте прод-планировщик и Slack вебхуки.
