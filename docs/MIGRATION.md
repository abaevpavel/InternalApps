# Daly Schedule — миграция Lovable → новый фронт (прод-ready)

> Цель: перенести **всё** приложение с Lovable на новый фронт (`apps/task-planner`)
> и провязать **напрямую на прод** (без тестовых кредов). Этот док — план миграции и
> «как всё должно работать». Источники правды: [`SPEC.md`](SPEC.md) (правила),
> [`AI-MODULES.md`](AI-MODULES.md) (n8n-пайплайн), [`../apps/task-planner/README.md`](../apps/task-planner/README.md)
> (архитектура). Создано: 2026-06-29.

---

## 1. Подход
- **НЕ переписываем с нуля.** Новый фронт `apps/task-planner` (React+Vite+TS) уже
  реализует ядро (Tasks/Create/Availability/Admin/Profile/Login + движок якорей +
  Google travel + Proposed-редактор). Берём его как базу.
- **Доводим до полного паритета с Lovable** — добавляем фичи/экраны Lovable, которых
  ещё нет (заполним §4 по скринам).
- **Убираем dev-каркас** (тестовые механики) и **провязываем на прод** (§5).
- **«Мозги» готовы:** n8n-планировщик стабилен (3 агента на Code-парсинге, см. AI-MODULES).

---

## 2. Прод-таргеты (подключим креды при провязке)

| Что | Прод-значение | Статус |
|---|---|---|
| n8n планировщик (webhook) | `https://basementremodeling.app.n8n.cloud/webhook/d3dfcd18-d54a-4b7b-904c-4d3cc7b0df27` | ✅ известен |
| n8n Slack-рассыльщик (webhook) | `https://basementremodeling.app.n8n.cloud/webhook/67341a95-…` | ⚠️ воркфлоу `aa6XaAQ6` Disabled, включить + `TEAM_TO_USER` |
| Supabase | `https://dhtewaqfcsejdllwhgtl.supabase.co` (проект «crews scheduling») | ✅ известен; anon-ключ в env |
| Google Maps key | **нужен прод-ключ БЕЗ referrer-ограничения на :5174** (или referrer = прод-домен) | 🔴 получить |
| Хостинг фронта | TBD (сейчас stage) | 🔴 выбрать (Vercel/Netlify/…) |
| n8n инстанс | **basement** (прод); t3d-projects — временно. В перспективе VPS self-host | ✅ §SPEC 2 |

**Синк справочников из Airtable — через Supabase Edge Functions (НЕ n8n!):**
| Кнопка/синк | Edge Function | Airtable → Supabase |
|---|---|---|
| Projects → Sync from Airtable | `sync-airtable-projects` | Projects → `projects` |
| Team → Sync Teams info | `sync-airtable-teams` | Crews/Teams → `teams` |
| Skills → Sync from Airtable | `sync-airtable-skills` | Skills w/ Rating → `skills` |
| Team → Sync Team Accounts | `sync-team-accounts` | команды → auth + `profiles` |
| (оркестратор) | `auto-sync-airtable` | projects + teams |

Вызов из фронта: `supabase.functions.invoke('<fn>')`. Кнопки в Admin уже провязаны.

**Убрать из прод-сборки (тест-механика):**
- `VITE_N8N_PLANNER_TEST_WEBHOOK` и режим `test` в Send to AI.
- 🧪 кнопки: «Reset test set», «Delete all», копии Proposed (`request_task_id`),
  хардкод `TEST_ANCHOR_TIMES` — заменить на **прод-модель** (плавный переход статусов
  одной строки, §SPEC 4).
- service_role-ключ — **ротировать перед продом** (§SPEC 10).

---

## 3. Что уже построено в новом фронте (база)

| Раздел | Статус | Примечание |
|---|---|---|
| Login (Supabase Auth) | ✅ | email+пароль |
| Tasks: Requested | 🟡 | список+создание+удаление; Send to AI (тест-режим — убрать) |
| Tasks: Proposed | ✅ | движок якорей, drag внутри/между бригадами, Google-travel + пересчёт, ⓘ-поповер, Explain Yourself, Approve, Save |
| Tasks: Scheduled | 🟡 | read-only + Send to Slack (Slack перетестировать) |
| Create Task | 🟡 | форма Project/Other, Exact/Timeframe, Skills, Additional Stop |
| Teams Availability | 🟡 | недоступность бригад |
| Admin | 🟡 | справочники + Sync from Airtable |
| Profile | 🟡 | профиль/пароль |
| ПМ-вью (урезанное) | 🔴 | отдельный функционал — из Lovable (§4) |

(🟡 = есть, но требует сверки с Lovable на паритет / доводки; 🔴 = нет.)

---

## 4. Экраны Lovable — матрица паритета (ЗАПОЛНЯЕМ ПО СКРИНАМ)

> Юзер присылает скрины/репо Lovable → по каждому экрану фиксируем: что делает в
> Lovable, есть ли в новом фронте, и что доделать. Шаблон строки ниже.

| # | Экран Lovable | Что делает (поведение) | В новом фронте | Действие/гэп |
|---|---|---|---|---|
| **L-01** | **My Applications** (портал/хаб) | Главный дашборд: сетка карточек-приложений (6 шт: `06-HR-Checklists`, `06-HR-Gmail Auto Sender`, `02-Sales-Send an offer email`, `03-Production-Send Buildertrend Schedule`, `06-HR-Sync Airtable Contacts`, `03-Production-Checklist`), карточки фильтруются по роли юзера, у каждой — «Open Application» (внешняя ссылка ↗). Хедер: лого, «MY APPLICATIONS», бургер-меню: «Signed in as <email>», My Account, User Management (только Admin), My Applications, Sign out. | ✅ построен как **отдельное приложение `apps/portal`** (решено: Task Planner — отдельный SPA со своим Supabase, портал открывает его карточкой) | Подключить существующий Lovable-Supabase (креды), сверить схему — `apps/portal/README.md` §Schema |
| **L-02** | **User Management** (скрины 2026-07-02) | Вкладки **Users** / **Roles**. Users: таблица (аватар-инициалы, имя, email, роль, Joined dd.mm.yyyy, edit/delete), фильтр «All users (N)», Sort by Name, поиск. Roles: «Showing N roles • M applications available», **Create Role**, таблица (имя, описание, бейджи приложений «+N more», Created, edit/delete). Роль у юзера одна; роли динамические, роль→мультиселект приложений. | ✅ построен в `apps/portal` (+ Add User — whitelist-заведение юзера, в скрин не попал, решение: делаем) | Сверка с реальной схемой Lovable-Supabase |
| **L-03** | **My Account** (скрин 2026-07-02) | Карточка профиля: аватар-инициалы, имя (редактируется карандашом), email, бейдж роли, «Joined: Month D, YYYY». | ✅ построен в `apps/portal` (Profile в task-planner — отдельная вещь, не сверяем) | — |
| … | _(шлёшь скрины остальных приложений)_ | | | |

> ⚠️ **Архитектура — мульти-апп портал.** Task Planner (Daly Schedule) — **одно из
> приложений**. Вход, идентичность и User Management — на уровне портала. Доступ к
> приложениям и роли **могут различаться между приложениями**. Это напрямую влияет на
> auth/RLS/user-management → блок вопросов клиенту в §8.

**Особое внимание (из обсуждений):**
- **Роли/вью:** super_admin (Pavel + dev) видит всё; **ПМ = team_lead** — отдельное
  урезанное вью (Lovable-специфика, §SPEC 8). Задокументировать его экраны.
- **Поток статусов** в Lovable (как там Requested→…→Slack) — сверить с нашей моделью.

---

## 5. Прод-провязка (чеклист при портировании)

1. **env (прод):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_N8N_PLANNER_WEBHOOK`
   (прод basement), `VITE_N8N_SLACK_WEBHOOK`, `VITE_GOOGLE_MAPS_API_KEY` (unrestricted/прод-домен).
   Убрать `*_TEST_WEBHOOK`.
2. **Send to AI:** убрать `test`-режим и блокирующий поллинг → модель **SMS → «Pull AI
   result»** (§SPEC 6.2). Надёжно хранить `request_ID`.
3. **Прод-модель задач:** убрать копии/тест-кнопки; задача = одна строка, статусы
   `requested→proposed→scheduled` (§SPEC 4).
4. **Slack:** включить воркфлоу `aa6XaAQ6`, заполнить `TEAM_TO_USER` (где `slack_user_id`),
   сверить payload (§SPEC 6.4).
5. **RLS:** политики на `tasks`/`scheduled_tasks` под роли (super_admin/pm/team_lead) —
   подтвердить (§SPEC 8, B-09/B-10).
6. **Google Maps:** прод-ключ; включены Maps JavaScript API + Distance Matrix API;
   referrer = прод-домен. (Опц.) per-leg departure для трафика (§SPEC 5.4).
7. **Хостинг:** выбрать платформу, настроить env, домен; referrer Google под домен.

---

## 6. Порядок работ (фазы)
1. **Документация** (этот док + §4 по скринам Lovable) — сейчас.
2. **Паритет фронта:** добить недостающие экраны/фичи (включая ПМ-вью).
3. **Прод-модель:** убрать тест-каркас, перейти на плавный переход статусов + SMS/Pull.
4. **Прод-провязка:** env, креды, Google-ключ, Slack, хостинг (§5).
5. **Роли/RLS** под прод; ротация service_role.
6. **Приёмка:** прогон полного цикла на проде (Create → Send to AI → SMS → Pull →
   Proposed → Approve → Slack).

---

## 7. ❓ Вопросы клиенту — RLS & User Management (мульти-апп портал)

Портал «My Applications» объединяет разные приложения, у которых **могут быть разные
доступы**. Нужно зафиксировать модель прав. Вопросы по блокам:

> ✅ **Закрыто 2026-07-02 (скрины + ответы юзера, реализовано в `apps/portal`):**
> A2 — портал отдельный продукт, Task Planner открывается карточкой как отдельный SPA;
> A3 — портал-апки на общем портал-Supabase (переиспользуем существующий Lovable-проект),
> Task Planner на своём; B1/B2 — доступ к приложениям назначается **на роль**
> (роль → мультиселект приложений), вручную в User Management; B4 — Admin видит всё;
> C1 — User Management только для ролей с `is_admin`; C2/C3 — юзеры заводятся вручную
> заранее (Add User, whitelist по email), роль назначается там же; C4 — права
> централизованно в портал-БД. Переключение между апками — **бесшовно** (SSO-хэндофф
> сессии, см. `apps/portal/README.md` §SSO). Остальное (блок D — роли ВНУТРИ Task
> Planner, E) — открыто.

### A. Архитектура входа / портала
- A1. **Единый вход на весь портал?** Один Supabase Auth / SSO для всех приложений, или
  у каждого приложения свой вход?
- A2. **Портал — отдельный продукт?** «My Applications» — это существующий Lovable-хаб,
  куда Task Planner добавляется ссылкой («Open Application» ↗), или Task Planner надо
  встроить ВНУТРЬ портала?
- A3. **Один домен/проект Supabase на всё** или у приложений разные базы/проекты?
- A4. Идентичность: все юзеры на `@achgroupllc.com`? Кто owner (видим `p@achgroupllc.com`)?

### B. Доступ к приложениям (видимость карточек)
- B1. **Кто решает, какие приложения видит юзер** (какие карточки на дашборде)?
  Назначается вручную в User Management?
- B2. Модель доступа: «доступ к приложению X» задаётся **на юзера** или **на роль/отдел**?
- B3. Префиксы `06-HR / 02-Sales / 03-Production` — это **отделы**? Доступ по отделу
  (HR видит HR-приложения и т.д.)?
- B4. Есть ли «глобальный админ», который видит все приложения?

### C. User Management (экран)
- C1. **Кто имеет доступ** к User Management (только owner/super_admin)?
- C2. Что он умеет: создание юзеров, назначение **ролей**, назначение **доступа к
  приложениям**, сброс паролей, деактивация?
- C3. **Откуда заводятся юзеры**: вручную в этом экране / синк из Airtable / Google
  Workspace / приглашения по email?
- C4. Хранятся ли права централизованно (одна таблица на портал) или per-app?

### D. Роли и RLS ВНУТРИ Task Planner
- D1. Как **портал-доступ** соотносится с **внутренними ролями** Task Planner
  (`super_admin / pm / team_lead`)? Портал даёт доступ к приложению, а роль внутри —
  отдельно? Или роль одна на всё?
- D2. **RLS на данные Task Planner** (`tasks`/`scheduled_tasks`): кто что видит —
  PM свои проекты? team_lead свою бригаду (read-only Scheduled)? super_admin всё?
- D3. **ПМ-вью** (урезанное) — какие именно экраны/действия доступны ПМ vs super_admin?
- D4. Роли хранятся в общей `user_roles` (на портал) или в каждом приложении свои?

### E. Прод-безопасность
- E1. Ротация Supabase `service_role` перед продом (§SPEC 10).
- E2. RLS-политики на запись (`tasks`: insert/update/delete) под каждую роль —
  подтвердить, что прод-модель (плавный переход статусов) проходит RLS.

> Итог: пока эти вопросы открыты, **user-management и RLS для прода фиксировать рано** —
> сначала ответы клиента (особенно A1/A2 — встраивать ли Task Planner в портал, и B/C —
> кто и как раздаёт доступы).

---

## 8. Открытые вопросы для прода (из SPEC §10)
- 🕗 Строгие рабочие часы (старт/конец/лимиты) — к клиенту.
- timeframe-окна — использовать ли (§SPEC 5.2).
- Срок хранения Scheduled; нужен ли архив.
- Права/RLS + состав ПМ-вью.
- Slack: где `slack_user_id`, формат payload.
- service_role ротация; единая Supabase; хостинг.

---

## Что нужно от тебя сейчас
Присылай **скрины экранов Lovable** (по одному или пачкой) — я по каждому заполню §4
(поведение → есть/нет в новом фронте → что доделать). Начнём с главного экрана и
**ПМ-вью** (его в новом фронте нет). Параллельно держим §5 как чеклист прод-провязки.
