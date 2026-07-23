-- UNIQUE-констрейнты на прогресс и назначения чек-листов (BUG-1 / BUG-3).
-- Убирает гонки read-then-write: быстрый двойной клик мог создать дубли строк
-- прогресса (upsert читал-потом-писал без опоры на БД). После этой миграции
-- сервисы переходят на `upsert(onConflict)` — атомарно.
--
-- ⚠️ Применяется на боевом Lovable-Supabase (HR DASHBOARD) вручную через SQL Editor.
-- Идемпотентно: дедуп → дефолты → уникальные индексы, всё безопасно повторно.
-- Repo-миграции 0001 расходятся с боевой схемой — тут работаем по реальным именам
-- колонок, которые пишет портал (services/*-checklist.ts).

begin;

-- 1) Дедуп существующих дублей (иначе UNIQUE-индекс не создастся).
--    Оставляем по одной строке на ключ (первую по физическому ctid), остальные удаляем.
--    Дубли — редкое следствие гонок, строки почти идентичны, любую можно оставить.

-- 1a) project_checklist_progress по (project_id, task_id)
delete from public.project_checklist_progress a
using (
  select ctid, row_number() over (
    partition by project_id, task_id order by ctid
  ) as rn
  from public.project_checklist_progress
) b
where a.ctid = b.ctid and b.rn > 1;

-- 1b) employee_checklist_progress по (employee_id, task_id, phase)
delete from public.employee_checklist_progress a
using (
  select ctid, row_number() over (
    partition by employee_id, task_id, phase order by ctid
  ) as rn
  from public.employee_checklist_progress
) b
where a.ctid = b.ctid and b.rn > 1;

-- 1c) employee_checklists по (employee_id, checklist_id)
delete from public.employee_checklists a
using (
  select ctid, row_number() over (
    partition by employee_id, checklist_id order by ctid
  ) as rn
  from public.employee_checklists
) b
where a.ctid = b.ctid and b.rn > 1;

-- 1d) project_checklists по (project_id, checklist_id)
delete from public.project_checklists a
using (
  select ctid, row_number() over (
    partition by project_id, checklist_id order by ctid
  ) as rn
  from public.project_checklists
) b
where a.ctid = b.ctid and b.rn > 1;

-- 2) Дефолты на NOT NULL-колонки, которые сервис больше НЕ шлёт при upsert.
--    Так на INSERT значение придёт из БД, а на UPDATE (onConflict) не затрётся,
--    когда его нет в patch. Идемпотентно.
alter table public.project_checklist_progress  alter column is_not_applicable set default false;
alter table public.employee_checklist_progress alter column is_not_applicable set default false;
alter table public.employee_checklist_progress alter column completed          set default false;

-- 3) Уникальные индексы (цель для ON CONFLICT в upsert). IF NOT EXISTS — идемпотентно.
create unique index if not exists project_checklist_progress_project_task_uq
  on public.project_checklist_progress (project_id, task_id);

create unique index if not exists employee_checklist_progress_emp_task_phase_uq
  on public.employee_checklist_progress (employee_id, task_id, phase);

create unique index if not exists employee_checklists_emp_checklist_uq
  on public.employee_checklists (employee_id, checklist_id);

create unique index if not exists project_checklists_project_checklist_uq
  on public.project_checklists (project_id, checklist_id);

commit;

-- Остаточный риск (вне BUG-1/3): assignTemplate() делает delete-all-by-project + insert
-- (одна привязка на проект). Два одновременных вызова с РАЗНЫМИ шаблонами могут оставить
-- две строки (разные checklist_id) — этот UNIQUE их не ловит. Если понадобится строго
-- «один шаблон на проект» — отдельный UNIQUE на (project_id) + upsert. Пока вне скоупа.
