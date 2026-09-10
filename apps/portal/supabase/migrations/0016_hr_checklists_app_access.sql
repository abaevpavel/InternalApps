-- 06-HR Checklists: доступ по выданному приложению, а не по имени роли.
--
-- Политики этих таблиц пускали админа либо роль, НАЗВАННУЮ «HR Manager». Человек, которому
-- апку выдали через Portal Settings, но чья роль зовётся иначе, проходил роут-гейт и видел
-- пустой экран: база возвращала ноль строк, а «No matches» выглядело как поломка списка.
--
-- Добавляем недостающее условие — то же, что уже работает в Production Checklist.
-- Старые политики НЕ удаляем: они permissive, то есть складываются, и HR Manager
-- продолжает работать как прежде. Это делает миграцию безопасной для тех, кто работает
-- прямо сейчас.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

do $$
declare
  t text;
  tables text[] := array[
    'employees',
    'employee_types',
    'checklists',
    'checklist_items',
    'employee_checklists',
    'employee_checklist_progress',
    'employee_phase_preferences',
    'checklist_photos'
  ];
begin
  foreach t in array tables loop
    -- Таблицы заводил Lovable, состав мог разойтись — пропускаем отсутствующие.
    if to_regclass('public.' || t) is null then
      raise notice 'skip: table % not found', t;
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_app_access', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (public.user_has_application_access(auth.uid(), '/checklists'))
        with check (public.user_has_application_access(auth.uid(), '/checklists'))
    $f$, t || '_app_access', t);
  end loop;
end $$;

-- Фото пунктов и чек-листов лежат в storage: без этих политик список грузится,
-- а картинки — нет.
drop policy if exists hr_checklist_photos_app_access on storage.objects;
create policy hr_checklist_photos_app_access on storage.objects
  for all to authenticated
  using (
    bucket_id in ('checklist-photos', 'checklist-item-photos')
    and public.user_has_application_access(auth.uid(), '/checklists')
  )
  with check (
    bucket_id in ('checklist-photos', 'checklist-item-photos')
    and public.user_has_application_access(auth.uid(), '/checklists')
  );
