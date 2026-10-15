-- Task Planner: приоритет задачи — High / Medium / Low (BAS-1434).
--
-- Было: целое 1–10 (1 — высший), необязательное, по умолчанию 5. Бейдж в портале делил
-- шкалу так: ≤3 — High, ≥7 — Low, остальное — Medium.
-- Стало: текст 'high' | 'medium' | 'low', обязательный, по умолчанию 'medium'. Старые
-- значения переводятся по тем же границам, что у бейджа, — визуально у пользователей
-- ничего не меняется. На момент применения в базе были только 3 (→ high) и 5 (→ medium).
--
-- В AI (n8n) приоритет уходит числом «больше — важнее»: high = 3, medium = 2, low = 1 —
-- так его уже читают формула второго агента и сортировка в сценарии (правок n8n не нужно).
-- Перевод — в портале (services/task-planner/n8n.ts).
--
-- Применять: Supabase CLI. Идемпотентно: повторный прогон ничего не меняет.

begin;

do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'tp_tasks' and column_name = 'priority') <> 'text' then
    alter table public.tp_tasks alter column priority drop default;
    alter table public.tp_tasks alter column priority type text using (
      case
        when priority is null then 'medium'
        when priority <= 3 then 'high'
        when priority >= 7 then 'low'
        else 'medium'
      end
    );
  end if;
end $$;

update public.tp_tasks set priority = 'medium' where priority is null;

alter table public.tp_tasks alter column priority set default 'medium';
alter table public.tp_tasks alter column priority set not null;

alter table public.tp_tasks drop constraint if exists tp_tasks_priority_check;
alter table public.tp_tasks add constraint tp_tasks_priority_check check (priority in ('high', 'medium', 'low'));

comment on column public.tp_tasks.priority is
  'Приоритет (BAS-1434): high | medium | low. Влияет на порядок задач в дне бригады при построении расписания AI.';

commit;
