-- Task Planner: вид недоступности бригады и заметка (BAS-1446).
--
--   • kind — Vacation / Sick leave / Other (решение Vlad 22.10.2026: трёх хватит).
--     Старые записи без вида становятся vacation.
--   • note — необязательная заметка к периоду.
--   • Права не меняются: читают и пишут Admin, PM и Schedule Manager (tp_sees_all_tasks, 0028/0039).
--     Политики «бригадир правит свою бригаду» в базе уже нет (снята в 0028).
--
-- Применять: Supabase CLI. Идемпотентно.

begin;

alter table public.tp_team_availability add column if not exists kind text not null default 'vacation';
alter table public.tp_team_availability add column if not exists note text;

alter table public.tp_team_availability drop constraint if exists tp_availability_kind_check;
alter table public.tp_team_availability add constraint tp_availability_kind_check
  check (kind in ('vacation', 'sick_leave', 'other'));

comment on column public.tp_team_availability.kind is
  'Почему бригада недоступна: vacation | sick_leave | other.';
comment on column public.tp_team_availability.note is
  'Необязательная заметка к периоду.';

commit;
