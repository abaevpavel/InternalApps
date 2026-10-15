-- Task Planner: бригада, пропавшая из Airtable, помечается неактивной, а не удаляется.
--
-- Было: синк sync-airtable-teams удалял такую бригаду. У задач ссылка на бригаду
-- (tp_tasks.team_id) без внешнего ключа — задачи оставались со ссылкой в никуда;
-- доступность бригады удалялась каскадом; привязанный профиль ронял удаление.
-- Стало: is_active = false (вернулась в Airtable — снова true). Неактивные бригады не
-- предлагаются при создании задачи, в доступности и не уходят в Send to AI; в
-- Directories видны с пометкой. Решение Владислава 15.10.2026.
--
-- Применять: Supabase CLI. Идемпотентно.

alter table public.tp_teams add column if not exists is_active boolean not null default true;

comment on column public.tp_teams.is_active is
  'false — бригады больше нет в представлении Airtable (синк не удаляет, а помечает).';
