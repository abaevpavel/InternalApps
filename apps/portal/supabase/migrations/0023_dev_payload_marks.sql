-- Dev Apps: пометки полей payload'а — «удалить» / «оставить» / «добавить» (BAS-1503 / BAS-1505).
--
-- «add» — поля, которых в payload'е ещё нет, но их надо добавить (экран показывает их зелёными
-- на своём месте в дереве); для них хранятся тип и заметка.
--
-- Ключ — (scope, path). scope = вид payload'а Mac-приложения ('mac:proposal', 'mac:changeOrder',
-- 'mac:deposit'): удалить поле можно только из payload'а целиком, а один и тот же payload получают
-- несколько сценариев — поэтому пометка общая для всех них. Для остальных вебхуков scope =
-- 'scenario:<id>'. path — путь в payload'е ('estimateResult.categories[].name'); пометка ветки
-- распространяется на всё внутри (это делает экран).
--
-- Доступ — как у Dev Apps. Применять вручную: SQL Editor. Идемпотентно.

-- Если таблицу успели создать первой версией этого файла — дотянуть до текущей.
create table if not exists public.dev_payload_marks (
  scope           text        not null,
  path            text        not null,
  status          text        not null check (status in ('delete', 'keep', 'add')),
  field_type      text        check (field_type is null or length(field_type) <= 40),
  note            text        check (note is null or length(note) <= 1000),
  updated_by      uuid        default auth.uid(),
  updated_by_name text,
  updated_at      timestamptz not null default now(),
  primary key (scope, path)
);

alter table public.dev_payload_marks add column if not exists field_type text;
alter table public.dev_payload_marks add column if not exists note text;
alter table public.dev_payload_marks drop constraint if exists dev_payload_marks_status_check;
alter table public.dev_payload_marks add constraint dev_payload_marks_status_check check (status in ('delete', 'keep', 'add'));

create or replace function public.dev_payload_marks_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := auth.uid();
  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email)
    into new.updated_by_name
  from public.profiles p where p.user_id = auth.uid() limit 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists dev_payload_marks_touch on public.dev_payload_marks;
create trigger dev_payload_marks_touch before insert or update on public.dev_payload_marks
  for each row execute function public.dev_payload_marks_touch();

alter table public.dev_payload_marks enable row level security;

drop policy if exists dev_payload_marks_access on public.dev_payload_marks;
create policy dev_payload_marks_access on public.dev_payload_marks for all to authenticated
  using (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'))
  with check (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'));

revoke all on public.dev_payload_marks from anon, authenticated;
grant select, insert, update, delete on public.dev_payload_marks to authenticated;
