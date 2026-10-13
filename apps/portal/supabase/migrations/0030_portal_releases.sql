-- Обновления приложений портала: колокольчик в хедере, только для роли Developer.
--
-- Одна запись = один выкат одного приложения: версия, короткий список изменений и подпись —
-- кто пушил, из какого репозитория, ветки и коммита. У каждого пункта — подробность (details). Записи добавляются при каждом выкате.
-- Читать может только портальная роль Developer (RLS); писать из браузера нельзя никому.
--
-- В конце — история выкатов задним числом по git InternalApps (июль–октябрь 2026).
--
-- Применять вручную: Supabase → SQL Editor. Идемпотентно.

create table if not exists public.portal_releases (
  id          uuid primary key default gen_random_uuid(),
  app_code    text        not null,
  version     text        not null,
  released_at timestamptz not null default now(),
  items       text[]      not null default array[]::text[],
  -- Подробности к пунктам: details[n] раскрывается при наведении на items[n].
  details     text[]      not null default array[]::text[],
  pushed_by   text,
  repo        text,
  branch      text,
  commit_sha  text,
  created_at  timestamptz not null default now(),
  unique (app_code, version)
);

-- Если таблица уже создана первой версией этой миграции — добавить колонку.
alter table public.portal_releases add column if not exists details text[] not null default array[]::text[];

create index if not exists portal_releases_time on public.portal_releases (released_at desc);

create or replace function public.portal_is_developer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.name = 'Developer'
  )
$$;

revoke all on function public.portal_is_developer() from public;
grant execute on function public.portal_is_developer() to authenticated;

alter table public.portal_releases enable row level security;

drop policy if exists portal_releases_read on public.portal_releases;
create policy portal_releases_read on public.portal_releases
  for select to authenticated
  using (public.portal_is_developer());

revoke all on public.portal_releases from anon, authenticated;
grant select on public.portal_releases to authenticated;

-- История задним числом. Повторный запуск обновляет пункты и подробности.
insert into public.portal_releases (app_code, version, released_at, items, details, pushed_by, repo, branch, commit_sha) values
  ('buildertrend-schedule', '1.0.0', timestamptz '2026-07-13 23:00:00+00', array['New app: send a Buildertrend schedule to the client from the portal']::text[], array['Pick a project, the schedule exported from Buildertrend is attached and emailed to the client — replaces the manual send.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '070de27'),
  ('task-planner', '1.0.0', timestamptz '2026-07-22 23:00:00+00', array['Moved into the portal: shared database (tp_ tables), Google sign-in, unified menu', 'App settings: webhooks and resources', 'Google Maps works in production']::text[], array['Task Planner was a separate Lovable app with its own Supabase and login. Its tables now live in the portal database with the tp_ prefix, users sign in with the same Google account and screens open from the portal menu.', 'Planner and Slack webhook URLs are stored in App Settings instead of code, so they can be changed without a deploy.', 'Fixed the Maps loader on the production domain — travel times and address lookups work outside localhost.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'cb83cfc'),
  ('portal', '1.0.0', timestamptz '2026-07-23 23:00:00+00', array['Per-app access gate on routes', 'Atomic save of checklist progress and assignments (BUG-1, BUG-3)', 'Code split by route: initial load 2.2 MB → 503 kB']::text[], array['A user can open an app only if one of their portal roles grants it — a direct link to another app shows Access denied.', 'Two people saving at the same time no longer overwrite each other: progress and assignments are saved with a database upsert and a unique key.', 'Each app is loaded only when opened, so the portal home opens about four times faster.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '2bfeb27'),
  ('portal', '1.1.0', timestamptz '2026-08-04 23:00:00+00', array['Burger menu split into app block and portal block', 'User Management moved to Portal Settings', 'All UI text in English']::text[], array['When inside an app, its screens and settings are listed first, portal items (account, settings, sign out) below.', 'Users, roles and invitations are managed in one place for the whole portal.', 'Every screen, button and message was translated — new UI text is written in English only.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '9c2fa0c'),
  ('task-planner', '1.1.0', timestamptz '2026-08-04 23:00:00+00', array['App views Planner Admin / Team Lead, set in App Settings → Roles']::text[], array['Portal roles were mapped to two app views: Planner Admin sees planning, Team Lead sees own crew. Replaced by module roles in 1.4.0.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '892dec9'),
  ('task-planner', '1.2.0', timestamptz '2026-08-13 23:00:00+00', array['Task execution: crew marks tasks completed, adds notes and photos', 'Approvals screen for the planner', 'Task event history (who did what and when)']::text[], array['My Tasks shows the approved schedule of the crew — a task can be marked Complete with notes and photos from the phone.', 'Completed tasks wait for approval — the planner approves them or sends them back to rework with a comment.', 'Every completion, approval, rework, note and photo is written to an append-only log shown in task details.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'bb14640'),
  ('portal', '1.2.0', timestamptz '2026-09-04 23:00:00+00', array['Edge functions closed to anonymous calls (SEC-9, SEC-10)', 'Invitations are accepted correctly — UI shows the real role', 'Fixes: empty answers to Make, Production Checklist AI import, Sales draft (BUG-7..10)']::text[], array['Supabase edge functions now require a signed-in user — the public anon key alone can no longer trigger them.', 'An invited user gets the invited roles on first sign-in — screens no longer show a role the user does not have.', 'Make no longer receives empty payloads, AI import fills the Production Checklist again, the Sales draft is saved and restored.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'fa8e47f'),
  ('portal', '1.3.0', timestamptz '2026-09-09 23:00:00+00', array['Sign-in with email and password — the admin sets the password in User Management', 'Show / hide password on the sign-in screen']::text[], array['For people without a company Google account — Google sign-in still works for everyone else.', 'Eye icon in the password field.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '44dd493'),
  ('gmb-agent', '1.0.0', timestamptz '2026-09-09 23:00:00+00', array['New app: GMB Agent settings on live data']::text[], array['Settings of the Google Business Profile agent are read from and saved to the live tables instead of a preview mock.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'ddac801'),
  ('task-planner', '1.2.1', timestamptz '2026-09-10 23:00:00+00', array['Skills, priority and app name in the header fixed (BAS 1410)', 'App renamed to 01-Task Planner']::text[], array['Required skills list loads, priority is saved correctly, the header shows the app name from the portal.', 'Typo "Daly" removed from the app name.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '544ec63'),
  ('portal', '1.3.1', timestamptz '2026-09-10 23:00:00+00', array['Apps reviewed before the demo: HR, Production, Sales, Buildertrend, HR Sync, GMB', 'HR checklists load instantly — access follows the granted app', 'Dropdowns select items again']::text[], array['Text, empty states and errors checked and fixed in each app.', 'Checklists are fetched in one query — HR users see them through the app granted to their role.', 'Fixed a regression where clicking an option did not select it.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '1bc62f1'),
  ('portal', '1.4.0', timestamptz '2026-09-17 23:00:00+00', array['Home: My Applications / My Links tabs, compact cards (BAS 1529)']::text[], array['Apps and external links are on separate tabs — cards are smaller so more fit on the screen.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'fa985f6'),
  ('receipt-import', '1.0.0', timestamptz '2026-09-23 23:00:00+00', array['New app: import of card transactions, Live by default, Dry run in a menu (BAS 1450)', 'Notification recipients and editable AI prompts (BAS 1473, BAS 1474)', 'Employees and card numbers synced from Airtable (BAS 1472)', 'Every change asks for confirmation and can be undone for 10 seconds — change history']::text[], array['Upload a bank export — Live imports into Airtable, Dry run only shows what would happen. Import history is split into Live imports and Dry runs.', 'Who gets the matching emails and the prompts the AI uses can be changed on screen — checks match what the readers expect.', 'Cards are linked to people — new people can be added from the Contacts Directory.', 'Each save shows what will change and waits 10 seconds before it is written — all changes are logged with who and when.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '99572e5'),
  ('gmb-agent', '1.1.0', timestamptz '2026-09-23 23:00:00+00', array['Listing names and weekly email recipients (BAS 1543)', 'Change history and Undo']::text[], array['Listings show readable names — recipients of the weekly report are edited on screen.', 'Every settings change is logged and the last one can be undone.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'a09b521'),
  ('portal', '1.5.0', timestamptz '2026-09-23 23:00:00+00', array['A user can hold several portal roles (Add User / Edit User)']::text[], array['Roles are picked with checkboxes — app access is the union of all the user''s roles.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '067e713'),
  ('dev-apps', '1.0.0', timestamptz '2026-09-23 23:00:00+00', array['New app: catalog of Make sales-chain emails with comments (BAS 1556, BAS 1504)']::text[], array['Every email sent by the sales scenarios is listed with its text and trigger — developers leave comments on each.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'e5c3719'),
  ('dev-apps', '1.1.0', timestamptz '2026-09-25 23:00:00+00', array['Airtable and Payloads tabs, target payload structure of the Mac app (BAS 1503, BAS 1504, BAS 1505)']::text[], array['Airtable fields used by the scenarios and sample webhook payloads are browsable — the target payload format of the Mac app is documented.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '3be1ce8'),
  ('buildertrend-schedule', '1.0.1', timestamptz '2026-09-30 23:00:00+00', array['Project picker shows only active projects (BAS 1611)']::text[], array['Closed and cancelled projects are hidden from the selector.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'bf9c034'),
  ('commission-app', '1.0.0', timestamptz '2026-10-05 23:00:00+00', array['New app: confirm commission payouts for change orders, with history (BAS 1635)']::text[], array['Billing opens the link from the payout request, sees the requested change orders and confirms them — the status is written to Airtable and every confirmation is kept in history.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '95bf061'),
  ('commission-app', '1.1.0', timestamptz '2026-10-05 23:00:00+00', array['History shows the Airtable ids of changed records', 'Empty state when there is nothing to confirm', 'History filters: dates, requester, approver, search']::text[], array['Each history row lists the base, table and record ids that were changed.', 'Instead of an empty table the screen says that all requested payouts are already processed.', 'Filter history by date range, who requested, who confirmed, and free text.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'b5f89bb'),
  ('portal', '1.6.0', timestamptz '2026-10-05 23:00:00+00', array['Portal Settings → Users grouped by role, collapsible blocks']::text[], array['Users are listed under their roles, users without a role last — each block can be collapsed.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '50f44bf'),
  ('portal', '1.7.0', timestamptz '2026-10-06 23:00:00+00', array['Collapsible blocks, remembered per user (BAS 1628)', 'Apps get a department — name shown as DEPT — name (BAS 1681)', 'Home and My Links: Cards / List view, remembered per user']::text[], array['Blocks in settings screens collapse — what is collapsed is saved for the user on any computer.', 'Admin sets the app name and department in App Settings — the home page groups apps by department.', 'A switch between cards and a compact list — the choice is saved for the user.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', 'cf47e4d'),
  ('task-planner', '1.3.0', timestamptz '2026-10-06 23:00:00+00', array['Test mode banner in Requested — Reset test set removed']::text[], array['Requested keeps the original tasks while Send to AI works on copies — a banner explains this.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '0c30922'),
  ('task-planner', '1.3.1', timestamptz '2026-10-07 23:00:00+00', array['Create Task returns to Tasks after saving (BAS 1410)', 'Address suggestions from Google Places (BAS 1410)', 'Create Task no longer fails on an empty title']::text[], array['Previously the user was sent to the portal home.', 'Additional stop address is typed with suggestions limited to the DC/MD/VA area.', 'The title is taken from the first line of the description when not given.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '21b09f6'),
  ('portal', '1.7.1', timestamptz '2026-10-07 23:00:00+00', array['Custom dropdowns instead of system ones: search for long lists, open upward near the bottom']::text[], array['Same look on every browser — lists longer than 10 items get a search field — Esc closes.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '21b09f6'),
  ('task-planner', '1.4.0', timestamptz '2026-10-09 23:00:00+00', array['Module roles: Admin, Project Manager, Schedule Manager, Lead Carpenter — several per person (BAS 1509)', 'Roles assigned per user in App Settings → Roles', 'Menu, screens and buttons follow the roles — database rules match']::text[], array['Roles are stored per user instead of being derived from portal roles — rights add up when a person holds several.', 'Compact list of people with a toggle per role — for Lead Carpenter the crew matched by email is shown.', 'Send to AI, approve and Send tasks for Schedule Manager — create, edit and review for PM — complete for Lead Carpenter. The same rules are enforced by RLS.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '17e6c3e'),
  ('task-planner', '1.5.0', timestamptz '2026-10-12 23:00:00+00', array['My Tasks for PM and Lead Carpenter: Uncompleted / Completed / Closed by day (BAS 1510)', 'Period: this week, next week, this month, all dates, custom', 'PM sees own tasks and older ones marked no author']::text[], array['Own tasks split by status and grouped by day — a person with both roles switches between As PM and My crew.', 'Presets plus from/to dates — All dates removes the date filter.', 'Own = created by the user — tasks created before authors were saved are shown to every PM with a no author mark.']::text[], 'Vladyslav', 'abaevpavel/InternalApps', 'main', '484ea31')
on conflict (app_code, version) do update
  set items = excluded.items, details = excluded.details;
