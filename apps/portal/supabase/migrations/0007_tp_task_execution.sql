-- Task Planner — исполнение задачи бригадиром (My Tasks) + журнал манипуляций.
-- Модель и решения: docs/TASK-PLANNER-ROLES.md §5 (Р-5/Р-6/Р-7, 2026-08-13).
--
-- Что вводится:
--   1) вторая ось состояния — tp_tasks.execution_status (pending → completed → approved,
--      ветка rework → pending). Ось планирования (status: requested/proposed/scheduled)
--      НЕ трогается: scheduled и «выполнена» не взаимоисключающи;
--   2) append-only журнал tp_task_events — лента для окна «Task Completion Details»:
--      отметка бригадира, комментарий апрувера, возврат на доработку — в одной таблице;
--   3) tp_task_photos + ПРИВАТНЫЙ бакет tp-task-photos (в отличие от публичного
--      buildertrend-schedule-photos: там публичность — принятый риск SEC-5, новое его не наследует);
--   4) RLS на tp_tasks (долг §4.6): бригадир видит только задачи своей бригады.
--      Без этого фильтр в UI обходится прямым запросом с anon-ключом.
--
-- Почему действия бригадира — через RPC, а не прямой UPDATE:
--   RLS ограничивает СТРОКИ, а не КОЛОНКИ, а колоночные гранты вешаются на роль
--   (authenticated) — то есть заодно урезали бы админа, который ходит под той же ролью.
--   Поэтому: прямая запись в tp_tasks остаётся только у админа, а бригадир дёргает
--   security-definer функции, которые сами проверяют право, меняют статус и пишут событие
--   одной транзакцией. Побочный плюс — журнал нельзя подделать: прямой INSERT в
--   tp_task_events не разрешён никому (политики на запись нет вовсе).
--
-- Апрувер = портальный админ (user_has_admin_role). Это временно, финальную модель
-- уточняем у заказчика — docs/TASK-PLANNER-ROLES.md §7. При смене правится ОДНА
-- функция tp_can_approve_task(), политики не трогаются.
--
-- ⚠️ Применяется вручную через SQL Editor боевого проекта pilxwhtkhysanpukaliu.
-- Идемпотентно. Опирается на public.tp_my_team_id() (миграция 0006) и
-- public.user_has_admin_role(uuid) (портальная, заведена Lovable).

begin;

-- ============================================================
-- 1) Ось исполнения на задаче
-- ============================================================

alter table public.tp_tasks
  add column if not exists execution_status text not null default 'pending';

-- completed/completed_at/completed_by в схеме уже есть (наследие Lovable) — подстраховка
-- на случай расхождения repo-дампа с боевой БД. Legacy-флаг completed держим в синхроне
-- с новой осью: на него могут смотреть n8n/старые сценарии.
alter table public.tp_tasks add column if not exists completed boolean default false;
alter table public.tp_tasks add column if not exists completed_at timestamptz;
alter table public.tp_tasks add column if not exists completed_by uuid references auth.users(id) on delete set null;

-- Backfill до констрейнта: старые строки с completed=true → 'completed'.
update public.tp_tasks
set execution_status = 'completed'
where completed is true and execution_status = 'pending';

alter table public.tp_tasks drop constraint if exists tp_tasks_execution_status_check;
alter table public.tp_tasks
  add constraint tp_tasks_execution_status_check
  check (execution_status in ('pending', 'completed', 'approved', 'rework'));

-- Экран апрува («что ждёт подтверждения») и My Tasks («задачи бригады на дату»).
create index if not exists tp_idx_tasks_execution_status on public.tp_tasks (execution_status);
create index if not exists tp_idx_tasks_team_date on public.tp_tasks (team_id, scheduled_date);

comment on column public.tp_tasks.execution_status is
  'Ось исполнения (независима от status): pending → completed → approved, ветка rework → pending. Меняется только через tp_complete_task/tp_approve_task/tp_rework_task.';

-- ============================================================
-- 2) Журнал манипуляций (append-only)
-- ============================================================

create table if not exists public.tp_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tp_tasks(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,                 -- снимок на момент события: юзера могут удалить из портала
  actor_role text not null,         -- 'admin' | 'team_lead'
  event_type text not null,         -- 'completed' | 'approved' | 'rework' | 'note' | 'photo'
  from_value text,                  -- прежний execution_status (для смен статуса)
  to_value text,                    -- новый execution_status
  comment text,
  created_at timestamptz not null default now(),
  constraint tp_task_events_actor_role_check check (actor_role in ('admin', 'team_lead')),
  constraint tp_task_events_type_check check (event_type in ('completed', 'approved', 'rework', 'note', 'photo'))
);

create index if not exists tp_idx_task_events_task on public.tp_task_events (task_id, created_at desc);

comment on table public.tp_task_events is
  'Append-only лента событий по задаче (окно Task Completion Details). Пишется ТОЛЬКО security-definer функциями tp_*_task; прямой INSERT/UPDATE/DELETE не разрешён никому.';

-- ============================================================
-- 3) Фото к задаче
-- ============================================================

create table if not exists public.tp_task_photos (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tp_tasks(id) on delete cascade,
  event_id uuid references public.tp_task_events(id) on delete set null,
  path text not null,               -- ключ объекта в бакете tp-task-photos
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists tp_idx_task_photos_task on public.tp_task_photos (task_id, created_at desc);

-- Приватный бакет: фото объектов клиентов наружу по прямой ссылке не отдаём,
-- фронт показывает их через createSignedUrl.
insert into storage.buckets (id, name, public)
values ('tp-task-photos', 'tp-task-photos', false)
on conflict (id) do nothing;

-- ============================================================
-- 4) Хелперы прав
-- ============================================================

-- Может ли текущий юзер работать с задачей: админ портала — с любой,
-- бригадир — только со своей бригадой (tp_my_team_id() из миграции 0006).
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
        public.user_has_admin_role(auth.uid())
        or (t.team_id is not null and t.team_id = public.tp_my_team_id())
      )
  )
$$;

-- Кто подтверждает выполненную задачу. ВРЕМЕННО — портальный админ (решение 2026-08-13).
-- Когда заказчик ответит (PM из задачи / любой Planner Admin / отдельная роль Approver) —
-- меняется только тело этой функции.
create or replace function public.tp_can_approve_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_has_admin_role(auth.uid())
$$;

-- Роль автора события для журнала.
create or replace function public.tp_actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.user_has_admin_role(auth.uid()) then 'admin' else 'team_lead' end
$$;

revoke all on function public.tp_can_act_on_task(uuid) from public;
revoke all on function public.tp_can_approve_task(uuid) from public;
revoke all on function public.tp_actor_role() from public;
grant execute on function public.tp_can_act_on_task(uuid) to authenticated;
grant execute on function public.tp_can_approve_task(uuid) to authenticated;
grant execute on function public.tp_actor_role() to authenticated;

-- ============================================================
-- 5) Действия (единственный способ поменять execution_status)
-- ============================================================

-- Общая запись события. Внутренняя: наружу не грантуется, чтобы никто не писал
-- в журнал произвольные строки в обход действий.
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
    public.tp_actor_role(),
    p_event_type,
    p_from,
    p_to,
    nullif(btrim(coalesce(p_comment, '')), '')
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.tp_log_task_event(uuid, text, text, text, text) from public;

-- Бригадир (или админ) отмечает задачу выполненной.
create or replace function public.tp_complete_task(p_task_id uuid, p_comment text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_status text;
begin
  if not public.tp_can_act_on_task(p_task_id) then
    raise exception 'Not allowed to complete this task' using errcode = '42501';
  end if;

  select execution_status, status into v_prev, v_status
  from public.tp_tasks where id = p_task_id for update;

  if v_prev is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if v_status <> 'scheduled' then
    raise exception 'Only scheduled tasks can be completed' using errcode = '22023';
  end if;
  if v_prev not in ('pending', 'rework') then
    raise exception 'Task is already %', v_prev using errcode = '22023';
  end if;

  update public.tp_tasks
  set execution_status = 'completed',
      completed = true,
      completed_at = now(),
      completed_by = auth.uid()
  where id = p_task_id;

  return public.tp_log_task_event(p_task_id, 'completed', v_prev, 'completed', p_comment);
end $$;

-- Апрувер подтверждает выполнение — задача закрыта.
create or replace function public.tp_approve_task(p_task_id uuid, p_comment text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  if not public.tp_can_approve_task(p_task_id) then
    raise exception 'Not allowed to approve this task' using errcode = '42501';
  end if;

  select execution_status into v_prev from public.tp_tasks where id = p_task_id for update;
  if v_prev is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if v_prev <> 'completed' then
    raise exception 'Only completed tasks can be approved (current: %)', v_prev using errcode = '22023';
  end if;

  update public.tp_tasks set execution_status = 'approved', completed = true where id = p_task_id;

  return public.tp_log_task_event(p_task_id, 'approved', v_prev, 'approved', p_comment);
end $$;

-- Апрувер возвращает задачу на доработку. Комментарий обязателен — иначе бригадир
-- не поймёт, что переделывать.
create or replace function public.tp_rework_task(p_task_id uuid, p_comment text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  if not public.tp_can_approve_task(p_task_id) then
    raise exception 'Not allowed to send this task to rework' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_comment, '')), '') is null then
    raise exception 'A comment is required when sending a task to rework' using errcode = '22023';
  end if;

  select execution_status into v_prev from public.tp_tasks where id = p_task_id for update;
  if v_prev is null then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if v_prev <> 'completed' then
    raise exception 'Only completed tasks can be sent to rework (current: %)', v_prev using errcode = '22023';
  end if;

  update public.tp_tasks
  set execution_status = 'rework',
      completed = false,
      completed_at = null,
      completed_by = null
  where id = p_task_id;

  return public.tp_log_task_event(p_task_id, 'rework', v_prev, 'rework', p_comment);
end $$;

-- Заметка к задаче (Notes → Add Note). Статус не меняет.
create or replace function public.tp_add_task_note(p_task_id uuid, p_comment text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.tp_can_act_on_task(p_task_id) then
    raise exception 'Not allowed to comment on this task' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_comment, '')), '') is null then
    raise exception 'Note cannot be empty' using errcode = '22023';
  end if;

  return public.tp_log_task_event(p_task_id, 'note', null, null, p_comment);
end $$;

-- Регистрация загруженного фото: путь в бакете + событие в ленте.
create or replace function public.tp_add_task_photo(p_task_id uuid, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid;
begin
  if not public.tp_can_act_on_task(p_task_id) then
    raise exception 'Not allowed to add photos to this task' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_path, '')), '') is null then
    raise exception 'Photo path cannot be empty' using errcode = '22023';
  end if;

  v_event := public.tp_log_task_event(p_task_id, 'photo', null, null, null);
  insert into public.tp_task_photos (task_id, event_id, path, created_by)
  values (p_task_id, v_event, p_path, auth.uid());
  return v_event;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'tp_complete_task(uuid, text)',
    'tp_approve_task(uuid, text)',
    'tp_rework_task(uuid, text)',
    'tp_add_task_note(uuid, text)',
    'tp_add_task_photo(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- ============================================================
-- 6) RLS
-- ============================================================

-- 6.1 tp_tasks — долг §4.6. Сносим существующие политики по каталогу (имена на боевой
--     заводил Lovable и неизвестны), ставим свой полный набор.
--     Бэкенд не страдает: синк-функции и n8n ходят под service_role, RLS его не касается.
do $$
declare p record;
begin
  if to_regclass('public.tp_tasks') is null then
    raise exception 'public.tp_tasks not found';
  end if;

  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'tp_tasks' loop
    execute format('drop policy if exists %I on public.tp_tasks', p.policyname);
  end loop;

  alter table public.tp_tasks enable row level security;
end $$;

-- Админ портала — полный доступ (создание/правка/удаление задач, планирование).
create policy tp_tasks_admin_all on public.tp_tasks
  for all to authenticated
  using (public.user_has_admin_role(auth.uid()))
  with check (public.user_has_admin_role(auth.uid()));

-- Бригадир — ЧТЕНИЕ задач своей бригады. Записи нет намеренно: менять execution_status
-- он может только через tp_complete_task (см. шапку).
create policy tp_tasks_team_read on public.tp_tasks
  for select to authenticated
  using (team_id is not null and team_id = public.tp_my_team_id());

-- 6.2 Журнал: читать — тот, кто имеет доступ к задаче; писать — никто напрямую.
alter table public.tp_task_events enable row level security;

drop policy if exists tp_task_events_read on public.tp_task_events;
create policy tp_task_events_read on public.tp_task_events
  for select to authenticated
  using (public.tp_can_act_on_task(task_id));

-- 6.3 Фото: читать — тот же круг; вставка только через tp_add_task_photo.
alter table public.tp_task_photos enable row level security;

drop policy if exists tp_task_photos_read on public.tp_task_photos;
create policy tp_task_photos_read on public.tp_task_photos
  for select to authenticated
  using (public.tp_can_act_on_task(task_id));

-- 6.4 Storage. Бакет приватный: чтение/запись — только залогиненные, anon отрезан.
--     Скоуп «своя бригада» на объектах не проверяем: ключ объекта содержит task_id,
--     но связь объект↔бригада в storage.objects не выразить дёшево, а круг лиц —
--     сотрудники под Google-SSO. Ссылки наружу не расходятся: URL подписанные и временные.
drop policy if exists tp_task_photos_obj_read on storage.objects;
create policy tp_task_photos_obj_read on storage.objects
  for select to authenticated
  using (bucket_id = 'tp-task-photos');

drop policy if exists tp_task_photos_obj_insert on storage.objects;
create policy tp_task_photos_obj_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tp-task-photos');

drop policy if exists tp_task_photos_obj_delete on storage.objects;
create policy tp_task_photos_obj_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'tp-task-photos' and public.user_has_admin_role(auth.uid()));

commit;
