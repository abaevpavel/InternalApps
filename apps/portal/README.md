# Portal — «My Applications» (платформа)

Каркас портала: Google-вход + whitelist, сетка приложений, User Management (Users/Roles),
My Account. Портал — «проходная + раздача ключей»: решает, кого пускать и какие карточки
показывать; бизнес-логику приложений не содержит.

**Стек:** Vite + React 18 + TS, TanStack Query, Tailwind (лёгкие примитивы в
`src/components/ui.tsx`, без UI-кита), Supabase (Auth + Postgres + RLS).

## Запуск
```bash
npm install               # из корня монорепо
npm run dev -w portal     # или npm run dev:portal
```
Заполнить `.env` по `.env.example` (URL + anon key **существующего** Lovable-Supabase
портала — решение: переиспользуем его, см. «Schema» ниже).

## Как это работает

### Auth: Google OAuth + whitelist
1. Юзер жмёт «Sign in with Google» (Supabase Auth, provider `google`).
2. Залогиниться может любой Google-аккаунт, но `AuthProvider` ищет его email в
   `profiles` (whitelist). Нет записи → экран «Access denied», данных не видно (RLS).
3. Админ заводит юзера заранее: User Management → Add User (email + имя + роль).
   При первом входе триггер `on_auth_user_created` линкует `auth_user_id` по email.

### Доступ к приложениям
`роль → role_applications → applications`. Карточка видна, если приложение привязано
к роли юзера. Роль у юзера одна (`profiles.role_id`). Роли динамические (Create Role);
флаг `roles.is_admin` открывает User Management и право управлять users/roles (RLS).

### SSO между приложениями (бесшовное переключение)
Требование: юзер не должен логиниться в каждой апке. Приложения портала сидят на том же
Supabase-проекте, поэтому «Open Application» передаёт текущую сессию через URL-fragment:
`https://app.example.com#sso=<base64{at,rt}>` (см. `src/lib/sso.ts`). Приложение на
своей стороне вызывает `supabase.auth.setSession(...)` и чистит hash — консюмер будет
общим в `packages/lib`, чтобы каждая апка не писала своё. Fragment на сервер не уходит.
Task Planner — исключение: свой Supabase и свой auth (открывается просто по ссылке).

### БД и RLS
Референс-схема: `supabase/migrations/0001_portal_init.sql` (+ сид `0002`).
- `profiles` (whitelist: email, full_name, role_id, auth_user_id), `roles` (+`is_admin`),
  `applications` (code/name/url/sort_order), `role_applications` (M:N).
- RLS: справочники читают все authenticated; пишет только админ (`is_admin()`,
  security definer). Профиль: юзер видит/правит только свой (смена role_id/email
  не-админом блокируется триггером `protect_profile_columns`).

### Schema: подключён существующий Lovable-Supabase ✅
Переиспользуем проект Lovable **«HR DASHBOARD»** `pilxwhtkhysanpukaliu` (данные уже там).
Одна БД на весь портал + все прикладные апки (RBAC-остров: `profiles / roles /
user_roles / applications / role_applications / invitations`). Реальные таблицы/колонки
(снято интроспекцией PostgREST):

| Таблица | Колонки | Заметки |
|---|---|---|
| `profiles` | id, user_id, email, first_name, last_name, created_at, updated_at | `user_id` = auth.users.id |
| `roles` | id, name, description, permissions, created_at, updated_at | нет `is_admin` — админ по имени/permissions |
| `user_roles` | id, user_id, role_id | M:N user↔role (FK→roles), **без FK к profiles** |
| `applications` | id, name, description, url, icon, created_at, updated_at | нет `sort_order` — сортируем по имени |
| `role_applications` | id, role_id, application_id | FK→roles, applications |
| `invitations` | id, email, token, invited_by, role_ids[], created_at, expires_at, accepted_at | механизм Add User |

**RPC (используем):** `user_has_admin_role(user_id uuid)→bool` (админ-гейт),
`delete_user_profile(user_uuid uuid)→bool` (удаление юзера + auth). Ещё есть
`has_role`, `user_has_application_access` (в RLS-политиках).

**Отличия от первоначальной референс-схемы** (миграции `supabase/migrations/` —
теперь только исторический референс, на этом проекте НЕ применять):
- роль юзера — не `profiles.role_id`, а M:N через `user_roles` (юзер может иметь
  несколько ролей; доступ = объединение приложений всех ролей);
- Add User — не insert в `profiles`, а `invitations` (email + `role_ids[]`); профиль
  и `user_roles` создаёт Lovable-триггер при первом входе;
- имя — `first_name`/`last_name` (не `full_name`);
- админ — RPC `user_has_admin_role` (фолбэк: роль с именем «Admin»/маркером в permissions).

Всё это инкапсулировано в `src/services/data.ts` + `src/domain/types.ts`; страницы
и остальной код от схемы не зависят.

**Проверить RLS (важно):** не-админ не должен писать в `roles/applications/user_roles`
и не видеть чужие профили. Прогнать под HR Manager после подъёма.

## Настройка Google OAuth (один раз)
1. Google Cloud Console (проект клиента) → APIs & Services → OAuth consent screen:
   Internal (если Workspace) или External + домены.
2. Credentials → Create OAuth client ID (Web): Authorized redirect URI =
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase Dashboard → Authentication → Providers → Google: включить, вставить
   Client ID/Secret.
4. Authentication → URL Configuration: Site URL = прод-домен портала; в Additional
   Redirect URLs добавить `http://localhost:5175` (dev) и субдомены приложений.

## Статус / TODO
- [x] Каркас: Login (Google + whitelist gate), My Applications, My Account,
      User Management (Users + Roles), референс-миграции + сид.
- [ ] Креды существующего Supabase → `.env`, сверка реальной схемы (§Schema).
- [ ] Google provider в Supabase (§выше) — доступ к GC клиента есть.
- [ ] `applications.url` — проставить реальные субдомены по мере деплоя апок.
- [ ] SSO-консюмер в `packages/lib` (для дочерних приложений).
- [ ] Удаление юзера сейчас убирает только whitelist-запись (доступ теряется сразу);
      сам auth-аккаунт остаётся — вычистку можно добавить Edge Function'ом при желании.
- [ ] Деплой: статический сайт на AWS, свой субдомен.

План/оценка: [docs/app-estimates/00-Portal-Platform-Auth-Users-Roles.md](../../docs/app-estimates/00-Portal-Platform-Auth-Users-Roles.md)
