-- Сид под текущее состояние портала (как на скринах Lovable, 2026-07).
-- Применять только на чистом проекте; на существующем Lovable-Supabase НЕ нужен.

insert into public.roles (name, description, is_admin) values
  ('Admin', 'Full system administrator', true),
  ('HR Manager', 'Human Resources management', false)
on conflict (name) do nothing;

insert into public.applications (code, name, sort_order) values
  ('hr-checklists',         '06-HR-Checklists',                          10),
  ('gmail-sender',          '06-HR-Gmail Auto Sender',                   20),
  ('sales-offer',           '02-Sales-Send an offer email',              30),
  ('buildertrend-schedule', '03-Production-Send Buildertrend Schedule',  40),
  ('hr-sync',               '06-HR-Sync Airtable Contacts',              50),
  ('production-checklist',  '03-Production-Checklist',                   60)
on conflict (code) do nothing;

-- Admin → все приложения
insert into public.role_applications (role_id, application_id)
select r.id, a.id from public.roles r, public.applications a
where r.name = 'Admin'
on conflict do nothing;

-- HR Manager → HR-приложения + Production-Checklist (на скрине «+1 more» — уточнить состав)
insert into public.role_applications (role_id, application_id)
select r.id, a.id from public.roles r, public.applications a
where r.name = 'HR Manager'
  and a.code in ('hr-sync', 'hr-checklists', 'production-checklist', 'gmail-sender')
on conflict do nothing;

-- Whitelist-юзеры (как на скрине Users)
insert into public.profiles (email, full_name, role_id)
select v.email, v.full_name, r.id
from (values
  ('pavel.a@achgroupllc.com',        'Pavel Abaev',     'Admin'),
  ('p@achgroupllc.com',              'Pavel Abaev Dev', 'Admin'),
  ('dev@todor3d.com',                't3d developer',   'Admin'),
  ('elena.l@achgroupllc.com',        'Elena Lupan',     'HR Manager'),
  ('pavel.a@basementremodeling.com', 'dc dfs',          'HR Manager')
) as v(email, full_name, role_name)
join public.roles r on r.name = v.role_name
on conflict do nothing;
