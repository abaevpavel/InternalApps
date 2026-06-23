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
  if (s && typeof s === "object") {
    const lvl = toNumOrNull(s.level);
    const m = String(s.name || "").match(/-\s*(\d+)\s*$/); // уровень мог остаться в имени
    return { name: normSkillName(s.name), level: lvl != null ? lvl : (m ? Number(m[1]) : null) };
  }
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
