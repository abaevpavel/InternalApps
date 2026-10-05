-- BAS-1635: Commission App — подтверждение выплаты комиссий по Change Order'ам и история.
--
-- Поток: сотрудник в Retool запрашивает выплату → Make (4731449) ставит CO в Airtable
-- `Commission STATUS = REQUESTED` и шлёт billing'у письмо со ссылкой
-- `/commission-app?ids=rec…`. Billing подтверждает оплату в портале: edge-функция
-- `commission-payout` ставит PAID в Airtable и пишет строку сюда.
--
-- Писать в историю может только edge-функция (service role): у authenticated нет insert,
-- иначе запись «кто подтвердил» можно было бы подделать из браузера.
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

-- 1. История подтверждений -------------------------------------------------------------

create table if not exists public.cp_payout_confirmations (
  id                 uuid primary key default gen_random_uuid(),
  confirmed_at       timestamptz not null default now(),
  confirmed_by       uuid references auth.users(id) on delete set null,
  -- email аккаунта, под которым вошли. Храним текстом: пользователя могут удалить,
  -- а след «кто подтвердил» должен остаться.
  confirmed_by_email text not null,
  -- 'confirmed' — все отобранные записи стали PAID; 'partial' — часть; 'failed' — ни одной.
  status             text not null check (status in ('confirmed', 'partial', 'failed')),
  error              text,
  requester_names    text[] not null default '{}',
  -- id из ссылки письма — что именно просили подтвердить.
  requested_ids      text[] not null default '{}',
  -- По каждой записи: { id, billingRecordId, projectName, requester, commission,
  --   statusBefore, result: 'paid' | 'skipped' | 'failed', reason? }
  records            jsonb not null default '[]'::jsonb,
  -- Сумма комиссий по записям с result = 'paid'.
  total_paid         numeric(12, 2) not null default 0,
  paid_count         integer not null default 0
);

create index if not exists cp_payout_confirmations_at_idx
  on public.cp_payout_confirmations (confirmed_at desc);

alter table public.cp_payout_confirmations enable row level security;

drop policy if exists cp_confirmations_read on public.cp_payout_confirmations;
create policy cp_confirmations_read on public.cp_payout_confirmations
  for select to authenticated
  using (
    public.user_has_application_access(auth.uid(), '/commission-app')
    or public.user_has_admin_role(auth.uid())
  );

revoke all on public.cp_payout_confirmations from anon, authenticated;
grant select on public.cp_payout_confirmations to authenticated;

-- 2. Гейт доступа для edge-функции -----------------------------------------------------
-- Функция должна понять, выдана ли апка вызывающему, ДО записи в Airtable. История для
-- этого не годится: пока она пуста, select вернёт 0 строк и у тех, у кого доступ есть.
-- Поэтому одна строка-маркер под той же политикой: видна → доступ есть (тот же приём,
-- что в sync-receipt-employees).

create table if not exists public.cp_app_gate (
  id integer primary key check (id = 1)
);
insert into public.cp_app_gate (id) values (1) on conflict do nothing;

alter table public.cp_app_gate enable row level security;

drop policy if exists cp_app_gate_read on public.cp_app_gate;
create policy cp_app_gate_read on public.cp_app_gate
  for select to authenticated
  using (
    public.user_has_application_access(auth.uid(), '/commission-app')
    or public.user_has_admin_role(auth.uid())
  );

revoke all on public.cp_app_gate from anon, authenticated;
grant select on public.cp_app_gate to authenticated;

-- 3. Карточка на My Applications ------------------------------------------------------
-- Та же схема, что 0011/0017/0020: живая applications без code/sort_order, заполняем только
-- существующие колонки, строку опознаём по url. Доступ ролям выдаёт админ в Portal Settings;
-- здесь — только Admin, чтобы карточка сразу была видна тому, кто настраивает.

do $$
declare
  app_id uuid;
  cols   text := 'name, url';
  vals   text := $q$'Commission App', '/commission-app'$q$;
begin
  select id into app_id from public.applications where url = '/commission-app' limit 1;

  if app_id is null then
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'code') then
      cols := cols || ', code';
      vals := vals || $q$, 'commission-app'$q$;
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'sort_order') then
      cols := cols || ', sort_order';
      vals := vals || ', 500';
    end if;

    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'applications' and column_name = 'description') then
      cols := cols || ', description';
      vals := vals || $q$, 'Confirm commission payouts for Change Orders and see who confirmed what and when.'$q$;
    end if;

    execute format('insert into public.applications (%s) values (%s) returning id', cols, vals) into app_id;
  end if;

  insert into public.role_applications (role_id, application_id)
  select r.id, app_id from public.roles r where r.name = 'Admin'
  on conflict do nothing;
end $$;
