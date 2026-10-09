-- BAS-1509: роли модуля Task Planner — хранятся за пользователем, по нескольку на человека.
--
-- Было (0006–0008, решение Р-2): роль внутри апки нигде не хранилась, а выводилась —
-- админ портала → Planner Admin, совпадение email с tp_teams → Team Lead, плюс маппинг
-- «портальная роль → вид апки» в app_settings.roles_*. Видов два, у человека один.
--
-- Стало:
--   • доступ к модулю — по-прежнему портальный (глобальная роль, к которой привязана апка);
--   • ЧТО человек может внутри — роли модуля из app_user_roles, назначаются в
--     App Settings → Roles. Ролей четыре: admin, pm, schedule_manager, lead_carpenter;
--     у одного человека их может быть несколько (PM, который строит расписание, — pm +
--     schedule_manager);
--   • админ портала внутри модуля обходных прав НЕ получает: нужна роль — её назначают.
--     Назначает роли админ портала (экран настроек портальный).
--   • Lead Carpenter = бригадир: бригада по-прежнему находится по email (tp_teams.email),
--     но только у того, кому выдана роль lead_carpenter.
--
-- Права по ролям — матрица BAS-1509, зеркало во фронте: src/domain/task-planner/permissions.ts.
-- Тонкие правила по статусам (что править/удалять в каком статусе) — BAS-1514, не здесь.
--
-- Заменяет 0008_tp_planner_admin.sql: та на боевой не применялась и применять её
-- после этой миграции нельзя (вернёт права по портальному админу).
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

begin;

-- ============================================================
-- 1) Назначения ролей модуля — общая таблица портала (app_code), чтобы любая апка
--    со своими ролями пользовалась тем же механизмом.
-- ============================================================
create table if not exists public.app_user_roles (
  id         uuid primary key default gen_random_uuid(),
  app_code   text        not null,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  role_key   text        not null,
  granted_by uuid        references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (app_code, user_id, role_key)
);

alter table public.app_user_roles drop constraint if exists app_user_roles_tp_role_check;
alter table public.app_user_roles add constraint app_user_roles_tp_role_check check (
  app_code <> 'task-planner'
  or role_key in ('admin', 'pm', 'schedule_manager', 'lead_carpenter')
);

create index if not exists app_user_roles_user on public.app_user_roles (user_id, app_code);

alter table public.app_user_roles enable row level security;

-- Свои роли видит каждый (фронт по ним строит меню и экраны); все — админ портала.
-- Назначает и снимает — только админ портала.
drop policy if exists app_user_roles_read on public.app_user_roles;
create policy app_user_roles_read on public.app_user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.user_has_admin_role(auth.uid()));

drop policy if exists app_user_roles_write on public.app_user_roles;
create policy app_user_roles_write on public.app_user_roles
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

revoke all on public.app_user_roles from anon;
grant select, insert, update, delete on public.app_user_roles to authenticated;

-- История назначений — общий журнал портала (0019). Ключ записи — id назначения,
-- в данных — user_id, app_code и role_key.
drop trigger if exists portal_audit on public.app_user_roles;
create trigger portal_audit
  after insert or update or delete on public.app_user_roles
  for each row execute function public.portal_audit_row('/task-planner', 'id');

-- Есть ли у текущего пользователя роль в апке. security definer — вызывается из RLS-политик
-- других таблиц, не должна упираться в RLS app_user_roles.
create or replace function public.app_has_role(p_app text, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_user_roles r
    where r.user_id = auth.uid() and r.app_code = p_app and r.role_key = p_role
  )
$$;

revoke all on function public.app_has_role(text, text) from public;
grant execute on function public.app_has_role(text, text) to authenticated;

-- Короткая форма для Task Planner.
create or replace function public.tp_has_module_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_has_role('task-planner', p_role)
$$;

revoke all on function public.tp_has_module_role(text) from public;
grant execute on function public.tp_has_module_role(text) to authenticated;

-- Видит ли все задачи модуля: Admin, PM, Schedule Manager (Schedule screen).
create or replace function public.tp_sees_all_tasks()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tp_has_module_role('admin')
      or public.tp_has_module_role('pm')
      or public.tp_has_module_role('schedule_manager')
$$;

revoke all on function public.tp_sees_all_tasks() from public;
grant execute on function public.tp_sees_all_tasks() to authenticated;

-- ============================================================
-- 2) «Моя бригада» — только у Lead Carpenter. Правило совпадения email прежнее (0006).
-- ============================================================
create or replace function public.tp_my_team_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from public.tp_teams t
  where public.tp_has_module_role('lead_carpenter')
    and t.email is not null
    and lower(t.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
  limit 1
$$;

-- ============================================================
-- 3) Права на задачу
-- ============================================================

-- Отметить выполненной, приложить фото, оставить комментарий — Lead Carpenter своей бригады.
create or replace function public.tp_can_act_on_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tp_tasks t
    where t.id = p_task_id
      and t.team_id is not null
      and t.team_id = public.tp_my_team_id()
  )
$$;

-- Видеть задачу, её журнал и фото — кто видит все задачи, либо Lead Carpenter своей бригады.
create or replace function public.tp_can_view_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tp_sees_all_tasks() or public.tp_can_act_on_task(p_task_id)
$$;

revoke all on function public.tp_can_view_task(uuid) from public;
grant execute on function public.tp_can_view_task(uuid) to authenticated;

-- Принять / не принять выполненную работу — PM.
create or replace function public.tp_can_approve_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tp_has_module_role('pm')
$$;

-- Роль автора события. У человека ролей может быть несколько, поэтому роль берётся
-- по действию: проверка работы — PM, всё остальное (выполнение, фото, заметки) — Lead Carpenter.
create or replace function public.tp_actor_role(p_event_type text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p_event_type in ('approved', 'rework') then 'pm' else 'lead_carpenter' end
$$;

revoke all on function public.tp_actor_role(text) from public;
grant execute on function public.tp_actor_role(text) to authenticated;
drop function if exists public.tp_actor_role();

alter table public.tp_task_events drop constraint if exists tp_task_events_actor_role_check;
alter table public.tp_task_events add constraint tp_task_events_actor_role_check check (
  -- admin / team_lead — роли старых записей журнала, оставлены для истории.
  actor_role in ('admin', 'team_lead', 'pm', 'schedule_manager', 'lead_carpenter')
);

create or replace function public.tp_log_task_event(
  p_task_id uuid,
  p_event_type text,
  p_from text default null,
  p_to text default null,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.tp_task_events (task_id, actor_id, actor_email, actor_role, event_type, from_value, to_value, comment)
  values (
    p_task_id,
    auth.uid(),
    (select u.email from auth.users u where u.id = auth.uid()),
    public.tp_actor_role(p_event_type),
    p_event_type,
    p_from,
    p_to,
    nullif(btrim(coalesce(p_comment, '')), '')
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.tp_log_task_event(uuid, text, text, text, text) from public;

-- ============================================================
-- 4) RLS tp_tasks
-- ============================================================
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'tp_tasks' loop
    execute format('drop policy if exists %I on public.tp_tasks', p.policyname);
  end loop;
  alter table public.tp_tasks enable row level security;
end $$;

-- Чтение: Admin / PM / Schedule Manager — все задачи; Lead Carpenter — своей бригады.
create policy tp_tasks_read_all on public.tp_tasks
  for select to authenticated
  using (public.tp_sees_all_tasks());

create policy tp_tasks_team_read on public.tp_tasks
  for select to authenticated
  using (team_id is not null and team_id = public.tp_my_team_id());

-- Создание: PM — новые задачи (Requested); Schedule Manager — копии результата AI (Proposed).
create policy tp_tasks_insert on public.tp_tasks
  for insert to authenticated
  with check (
    (public.tp_has_module_role('pm') and status = 'requested')
    or (public.tp_has_module_role('schedule_manager') and status = 'proposed')
  );

-- Правка: PM — поля задачи и дата; Schedule Manager — дата, раскладка Proposed, утверждение.
create policy tp_tasks_update on public.tp_tasks
  for update to authenticated
  using (public.tp_has_module_role('pm') or public.tp_has_module_role('schedule_manager'))
  with check (public.tp_has_module_role('pm') or public.tp_has_module_role('schedule_manager'));

-- Удаление: PM — Requested; Schedule Manager — Proposed (пересборка копий результата AI).
create policy tp_tasks_delete on public.tp_tasks
  for delete to authenticated
  using (
    (public.tp_has_module_role('pm') and status = 'requested')
    or (public.tp_has_module_role('schedule_manager') and status = 'proposed')
  );

-- Журнал и фото — тот, кто видит задачу.
drop policy if exists tp_task_events_read on public.tp_task_events;
create policy tp_task_events_read on public.tp_task_events
  for select to authenticated
  using (public.tp_can_view_task(task_id));

drop policy if exists tp_task_photos_read on public.tp_task_photos;
create policy tp_task_photos_read on public.tp_task_photos
  for select to authenticated
  using (public.tp_can_view_task(task_id));

-- ============================================================
-- 5) Справочники, настройки, доступность
-- ============================================================

-- Справочники (Directories) — Admin модуля.
do $$
declare t text;
begin
  foreach t in array array['tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types', 'tp_sync_logs'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists tp_write_admin on public.%I', t);
    execute format($f$
      create policy tp_write_admin on public.%I
        for all to authenticated
        using (public.tp_has_module_role('admin'))
        with check (public.tp_has_module_role('admin'))
    $f$, t);
  end loop;
end $$;

-- Прогоны планировщика и снимки батчей — Schedule Manager (Send to AI).
drop policy if exists tp_write_admin on public.tp_ai_teams_schedule;
create policy tp_write_admin on public.tp_ai_teams_schedule
  for all to authenticated
  using (public.tp_has_module_role('schedule_manager'))
  with check (public.tp_has_module_role('schedule_manager'));

drop policy if exists tp_batch_snapshots_admin on public.tp_task_batch_snapshots;
create policy tp_batch_snapshots_admin on public.tp_task_batch_snapshots
  for all to authenticated
  using (public.tp_has_module_role('schedule_manager'))
  with check (public.tp_has_module_role('schedule_manager'));

-- Доступность бригад — Admin, PM, Schedule Manager. У Lead Carpenter этого права нет.
drop policy if exists tp_write_admin on public.tp_team_availability;
drop policy if exists tp_availability_own_team on public.tp_team_availability;
create policy tp_write_admin on public.tp_team_availability
  for all to authenticated
  using (public.tp_sees_all_tasks())
  with check (public.tp_sees_all_tasks());

-- Настройки модуля (вебхук планировщика и т.п.) — Admin модуля. Было: super_admin из
-- tp_user_roles Lovable.
drop policy if exists tp_app_settings_write on public.tp_app_settings;
create policy tp_app_settings_write on public.tp_app_settings
  for all to authenticated
  using (public.tp_has_module_role('admin'))
  with check (public.tp_has_module_role('admin'));

-- Удаление фото из бакета — Admin модуля.
drop policy if exists tp_task_photos_obj_delete on storage.objects;
create policy tp_task_photos_obj_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tp-task-photos' and public.tp_has_module_role('admin'));

-- ============================================================
-- 6) Перенос
-- ============================================================

-- Бригадиры раньше попадали в модуль автоматически по email — даём им роль Lead Carpenter,
-- чтобы после миграции у них ничего не пропало.
insert into public.app_user_roles (app_code, user_id, role_key)
select 'task-planner', u.id, 'lead_carpenter'
from public.tp_teams t
join auth.users u on lower(u.email) = lower(t.email)
where t.email is not null
on conflict (app_code, user_id, role_key) do nothing;

-- Маппинг «портальная роль → вид апки» больше не используется.
delete from public.app_settings
where app_code = 'task-planner' and key in ('roles_admin', 'roles_team_lead');

commit;
