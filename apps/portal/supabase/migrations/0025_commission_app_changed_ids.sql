-- BAS-1635: история подтверждений хранит Airtable id изменённых записей отдельной колонкой.
--
-- Правило: в каждой записи истории — id той записи Airtable, в которую внесли изменение,
-- и где она лежит (база + таблица), чтобы по истории запись находилась без разбора JSON.
-- До этой миграции id были только внутри records[] (по каждой записи) и requested_ids
-- (что просили по ссылке, а не что изменили).
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

alter table public.cp_payout_confirmations
  add column if not exists airtable_base       text   not null default 'appucrtf5MBcFXVza',
  add column if not exists airtable_table      text   not null default 'tbl5z6kVeFL8wkr0s',
  -- id записей, которые реально стали PAID (Airtable вернул их в ответе на PATCH).
  add column if not exists changed_record_ids  text[] not null default '{}';

-- Строки, записанные до миграции: изменённые = записи с result = 'paid' из records[].
update public.cp_payout_confirmations c
set changed_record_ids = coalesce((
  select array_agg(e->>'id')
  from jsonb_array_elements(c.records) e
  where e->>'result' = 'paid'
), '{}')
where c.changed_record_ids = '{}';

create index if not exists cp_payout_confirmations_changed_ids_idx
  on public.cp_payout_confirmations using gin (changed_record_ids);
