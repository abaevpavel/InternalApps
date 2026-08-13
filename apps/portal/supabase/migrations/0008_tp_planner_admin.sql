-- Task Planner — «админ апки» в БД = вид **Planner Admin**, а не только админ портала.
--
-- Зачем: 0007 закрыл tp_tasks на запись условием user_has_admin_role() — то есть на
-- ПОРТАЛЬНОГО админа. Но у апки два вида (docs/TASK-PLANNER-ROLES.md §2), и вид
-- Planner Admin выдаётся ещё и маппингом «портальная роль → роль апки» в
-- App Settings → Roles (app_settings.roles_admin). Такой пользователь до 0007 писал задачи
-- (политики Lovable пускали любого authenticated), а после — упирался бы в RLS, хотя UI
-- показывает ему полный вид планировщика. Функция ниже приводит БД к той же модели, что и
-- фронтовый useTaskPlannerRole().
--
-- Порядок разбора совпадает с фронтом: админ портала → admin всегда; иначе роль ∈ roles_admin.
--
-- ⚠️ Применяется вручную через SQL Editor боевого проекта pilxwhtkhysanpukaliu, ПОСЛЕ 0007.
-- Идемпотентно (create or replace + пересоздание политик по именам из 0007).

begin;

-- Вид Planner Admin: админ портала ИЛИ юзер, чья портальная роль отмечена в
-- App Settings → Roles → Planner Admin (app_settings: app_code='task-planner', key='roles_admin',
-- value = jsonb-массив role_id). security definer: читает app_settings/user_roles в обход их RLS.
create or replace function public.tp_is_planner_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_has_admin_role(auth.uid())
     or exists (
       select 1
       from public.app_settings s
       cross join lateral jsonb_array_elements_text(
         case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end
       ) as mapped(role_id)
       join public.user_roles ur
         on ur.user_id = auth.uid()
        and ur.role_id::text = mapped.role_id
       where s.app_code = 'task-planner'
         and s.key = 'roles_admin'
     )
$$;

revoke all on function public.tp_is_planner_admin() from public;
grant execute on function public.tp_is_planner_admin() to authenticated;

-- Переводим на неё всё, что в 0007 смотрело на портального админа.
create or replace function public.tp_can_act_on_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tp_tasks t
    where t.id = p_task_id
      and (
        public.tp_is_planner_admin()
        or (t.team_id is not null and t.team_id = public.tp_my_team_id())
      )
  )
$$;

-- Кто подтверждает выполненную задачу. ВРЕМЕННО — вид Planner Admin (решение 2026-08-13,
-- ждём ответа заказчика: PM из задачи / любой Planner Admin / отдельная роль Approver).
create or replace function public.tp_can_approve_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tp_is_planner_admin()
$$;

create or replace function public.tp_actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.tp_is_planner_admin() then 'admin' else 'team_lead' end
$$;

-- Политика записи tp_tasks: тот же вид апки, а не портальная админка.
drop policy if exists tp_tasks_admin_all on public.tp_tasks;
create policy tp_tasks_admin_all on public.tp_tasks
  for all to authenticated
  using (public.tp_is_planner_admin())
  with check (public.tp_is_planner_admin());

-- Справочники апки (0006 закрывал их запись на портального админа) — по той же причине
-- переводим на вид апки: Planner Admin правит Task Types и доступность бригад,
-- иначе экраны Directories/Availability показывают ему то, что он не может сохранить.
do $$
declare
  t text;
  ref_tables text[] := array[
    'tp_projects', 'tp_teams', 'tp_skills', 'tp_task_types',
    'tp_team_availability', 'tp_ai_teams_schedule', 'tp_sync_logs'
  ];
begin
  foreach t in array ref_tables loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists tp_write_admin on public.%I', t);
    execute format($f$
      create policy tp_write_admin on public.%I
        for all to authenticated
        using (public.tp_is_planner_admin())
        with check (public.tp_is_planner_admin())
    $f$, t);
  end loop;
end $$;

-- Удаление фото из бакета — тоже вид апки (загрузка остаётся у всех authenticated).
drop policy if exists tp_task_photos_obj_delete on storage.objects;
create policy tp_task_photos_obj_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tp-task-photos' and public.tp_is_planner_admin());

commit;
