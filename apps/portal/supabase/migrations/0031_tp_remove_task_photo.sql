-- Task Planner: Lead Carpenter может удалить фото со своей задачи (крестик на превью).
--
-- Удаление идёт через функцию — как и загрузка (tp_add_task_photo): та же проверка
-- «задача своей бригады», и в журнал задачи пишется событие photo_removed, чтобы PM видел,
-- что фото было и его убрали. Закрытую (approved) задачу менять нельзя.
-- Сам файл из бакета удаляет фронт через Storage API (прямое удаление из storage.objects
-- запрещено), поэтому политика на удаление объекта расширена: свой файл может удалить автор.
--
-- Применять: Supabase CLI или SQL Editor. Идемпотентно.

begin;

alter table public.tp_task_events drop constraint if exists tp_task_events_type_check;
alter table public.tp_task_events add constraint tp_task_events_type_check check (
  event_type in ('completed', 'approved', 'rework', 'note', 'photo', 'photo_removed')
);

create or replace function public.tp_remove_task_photo(p_photo_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task uuid;
  v_path text;
  v_status text;
begin
  select task_id, path into v_task, v_path from public.tp_task_photos where id = p_photo_id;
  if v_task is null then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if not public.tp_can_act_on_task(v_task) then
    raise exception 'Not allowed to remove photos from this task' using errcode = '42501';
  end if;
  select execution_status into v_status from public.tp_tasks where id = v_task;
  if v_status = 'approved' then
    raise exception 'The task is closed, its photos cannot be changed' using errcode = '22023';
  end if;

  delete from public.tp_task_photos where id = p_photo_id;
  perform public.tp_log_task_event(v_task, 'photo_removed', null, null, null);
  return v_path;
end $$;

revoke all on function public.tp_remove_task_photo(uuid) from public;
grant execute on function public.tp_remove_task_photo(uuid) to authenticated;

-- Файл в бакете: удалить может Admin модуля или тот, кто его загрузил.
drop policy if exists tp_task_photos_obj_delete on storage.objects;
create policy tp_task_photos_obj_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tp-task-photos'
    and (public.tp_has_module_role('admin') or owner_id = auth.uid()::text)
  );

commit;
