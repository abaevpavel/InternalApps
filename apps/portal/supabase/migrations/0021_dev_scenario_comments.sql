-- Dev Apps: комментарии разработчиков к сценариям Make (BAS-1556 / BAS-1503).
--
-- Сам каталог — снимок JSON в репо и пересобирается скриптом, поэтому комментарии живут
-- отдельно, в базе: пересборка их не затирает. Ключ — id сценария Make.
--
-- Доступ — как у приложения: user_has_application_access(auth.uid(), '/dev-apps') или админ.
-- Писать можно только от своего имени; удалить — свой, админ — любой. Правки нет: комментарий
-- удаляют и пишут заново, чтобы лента оставалась честной.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.dev_scenario_comments (
  id              bigserial primary key,
  scenario_id     bigint      not null,
  body            text        not null check (length(btrim(body)) > 0 and length(body) <= 4000),
  created_by      uuid        not null default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now()
);

create index if not exists dev_scenario_comments_scenario on public.dev_scenario_comments (scenario_id, created_at);

-- Имя автора — снимком на момент записи, из profiles (а не из того, что прислал браузер).
create or replace function public.dev_scenario_comments_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email)
    into new.created_by_name
  from public.profiles p where p.user_id = auth.uid() limit 1;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists dev_scenario_comments_author on public.dev_scenario_comments;
create trigger dev_scenario_comments_author before insert on public.dev_scenario_comments
  for each row execute function public.dev_scenario_comments_author();

alter table public.dev_scenario_comments enable row level security;

drop policy if exists dev_scenario_comments_read on public.dev_scenario_comments;
create policy dev_scenario_comments_read on public.dev_scenario_comments for select to authenticated
  using (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'));

drop policy if exists dev_scenario_comments_write on public.dev_scenario_comments;
create policy dev_scenario_comments_write on public.dev_scenario_comments for insert to authenticated
  with check (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), '/dev-apps'));

drop policy if exists dev_scenario_comments_delete on public.dev_scenario_comments;
create policy dev_scenario_comments_delete on public.dev_scenario_comments for delete to authenticated
  using (created_by = auth.uid() or public.user_has_admin_role(auth.uid()));

revoke all on public.dev_scenario_comments from anon, authenticated;
grant select, insert, delete on public.dev_scenario_comments to authenticated;
grant usage on sequence public.dev_scenario_comments_id_seq to authenticated;
