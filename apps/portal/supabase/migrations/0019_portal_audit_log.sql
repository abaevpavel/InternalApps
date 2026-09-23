-- История изменений портала: Receipts Matcher и GMB Agent.
--
-- Одна таблица на всё и одна триггерная функция. Пишет ТОЛЬКО триггер в базе, поэтому в историю
-- попадает любая запись — с экрана, из edge-функции, от автоматизации — и обойти её нельзя.
-- Подключить ещё одну таблицу — одна строка `create trigger … execute function portal_audit_row(…)`.
--
-- Кто изменил:
--   • person     — есть auth.uid() (запрос от залогиненного пользователя портала);
--   • automation — нет auth.uid(): service role (синк сотрудников из Airtable), роль агента GMB
--     и т.п. В actor_name пишется роль Postgres, чтобы было видно, какая именно автоматика.
--
-- Шум не пишем: техничные поля (updated_at, updated_by, synced_at, last_seen_at) из сравнения
-- исключаются, и UPDATE, в котором изменились только они, в историю не попадает.
--
-- ⚠️ Триггеры висят на таблицах Никиты (receipt_matcher_*, gmb_*). Функция НИКОГДА не роняет
-- исходную запись: любая ошибка внутри глушится в WARNING. Отключить историю на таблице —
-- `drop trigger portal_audit on <table>`.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.portal_audit_log (
  id             bigserial primary key,
  -- Приложение, чья это история; по нему же решается, кто её видит (RLS ниже).
  app_url        text        not null,
  table_name     text        not null,
  row_key        text        not null,
  action         text        not null check (action in ('insert', 'update', 'delete')),
  old_data       jsonb,
  new_data       jsonb,
  changed_fields text[],
  actor_id       uuid,
  actor_name     text,
  actor_kind     text        not null check (actor_kind in ('person', 'automation')),
  changed_at     timestamptz not null default now()
);

create index if not exists portal_audit_log_app_time on public.portal_audit_log (app_url, changed_at desc);

alter table public.portal_audit_log enable row level security;

-- Читают те, у кого есть приложение, и админы. Писать из браузера нельзя никому.
drop policy if exists portal_audit_log_read on public.portal_audit_log;
create policy portal_audit_log_read on public.portal_audit_log
  for select to authenticated
  using (public.user_has_admin_role(auth.uid()) or public.user_has_application_access(auth.uid(), app_url));

revoke all on public.portal_audit_log from anon, authenticated;
grant select on public.portal_audit_log to authenticated;
revoke all on sequence public.portal_audit_log_id_seq from anon, authenticated;

/**
 * AFTER-триггер на строку. Аргументы: app_url, колонка-ключ, затем колонки, которые не
 * сравниваем (техничные). Пример: portal_audit_row('/receipt-import', 'id', 'updated_at', 'updated_by').
 */
create or replace function public.portal_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app     text := tg_argv[0];
  v_keycol  text := tg_argv[1];
  v_ignore  text[] := coalesce(tg_argv[2:], array[]::text[]);
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_uid     uuid;
  v_name    text;
  v_key     text;
  k         text;
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old) - v_ignore; end if;
    if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new) - v_ignore; end if;

    if tg_op = 'UPDATE' then
      select array_agg(key order by key) into v_changed
      from (select key from jsonb_each(v_old) union select key from jsonb_each(v_new)) keys
      where (v_old -> key) is distinct from (v_new -> key);
      -- Изменились только техничные поля — это не событие.
      if v_changed is null then return null; end if;
    end if;

    v_key := coalesce(v_new ->> v_keycol, v_old ->> v_keycol, '?');
    v_uid := auth.uid();

    if v_uid is not null then
      select coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email)
        into v_name
      from public.profiles p where p.user_id = v_uid limit 1;
      if v_name is null then
        select u.email into v_name from auth.users u where u.id = v_uid;
      end if;
    else
      v_name := current_user;  -- service_role, gmb_agent, … — какая именно автоматика
    end if;

    insert into public.portal_audit_log
      (app_url, table_name, row_key, action, old_data, new_data, changed_fields, actor_id, actor_name, actor_kind)
    values
      (v_app, tg_table_name, v_key, lower(tg_op), v_old, v_new, v_changed, v_uid, v_name,
       case when v_uid is null then 'automation' else 'person' end);
  exception when others then
    -- История не должна ломать запись, ради которой она ведётся.
    raise warning 'portal_audit_row(%.%): %', tg_table_schema, tg_table_name, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.portal_audit_row() from public, anon, authenticated;

-- Подключение таблиц. drop + create — чтобы повторный прогон обновлял аргументы.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('receipt_matcher_settings',     '/receipt-import', 'key',         array['updated_at', 'updated_by']),
      ('receipt_matcher_prompts',      '/receipt-import', 'key',         array['updated_at', 'updated_by']),
      ('receipt_matcher_card_numbers', '/receipt-import', 'id',          array['updated_at', 'updated_by']),
      ('receipt_matcher_employees',    '/receipt-import', 'id',          array['updated_at', 'updated_by', 'synced_at']),
      ('gmb_settings',                 '/gmb-agent',      'key',         array['updated_at', 'updated_by']),
      ('gmb_listings',                 '/gmb-agent',      'location_id', array['updated_at', 'updated_by', 'last_seen_at'])
    ) as v(tbl, app, keycol, ignore_cols)
  loop
    if to_regclass('public.' || t.tbl) is null then
      raise notice 'skip %: table not found', t.tbl;
      continue;
    end if;
    execute format('drop trigger if exists portal_audit on public.%I', t.tbl);
    execute format(
      'create trigger portal_audit after insert or update or delete on public.%I
         for each row execute function public.portal_audit_row(%L, %L%s)',
      t.tbl, t.app, t.keycol,
      (select coalesce(string_agg(format(', %L', c), ''), '') from unnest(t.ignore_cols) c)
    );
  end loop;
end $$;
