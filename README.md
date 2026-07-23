# InternalApps — монорепозиторий внутренних приложений basementremodeling.com

Один репозиторий, несколько внутренних приложений. Бэкенд общий — **Supabase**
«HR DASHBOARD»; фронт — один SPA (портал) + приложения роутами внутри него; всё
раздаётся статикой за nginx с одного домена `internal-apps.basementremodeling.com`.
См. «Правила платформы» ниже.

## Структура
```
apps/
  portal/                Платформа + ВСЕ приложения роутами (включая Task Planner → /task-planner).
  hr-checklists/         06-HR-Checklists. [плейсхолдер]
  gmail-sender/          06-HR-Gmail Auto Sender. [плейсхолдер]
  sales-offer/           02-Sales-Send an Offer Email. [плейсхолдер]
  hr-sync/               06-HR-Sync Airtable Contacts. [плейсхолдер]
  production-checklist/  03-Production-Checklist. [плейсхолдер, ещё не оценён]
packages/
  ui/                    Общий дизайн-система, лого, shadcn-компоненты. [плейсхолдер]
  lib/                   Общий Supabase-клиент, errMsg, типы. [плейсхолдер]
docs/
  PORTAL.md              Единый источник правды по порталу (статус, аудит, долги).
  DEPLOYMENT.md          Деплой на AWS EC2 (билд + rsync, плавающий IP).
  TASK-PLANNER.md        Подсистема Task Planner: n8n-мозг, бизнес-правила, дебаг.
  TASK-PLANNER-MIGRATION.md  Рунбук миграции БД Task Planner в общий Supabase.
  app-estimates/         Планы и оценки по каждому приложению.
```

## Workspaces (npm)
```bash
npm install                      # ставит зависимости всех apps/packages
npm run dev:task-planner         # дев-сервер Task Planner
npm run build:task-planner       # прод-сборка Task Planner
# или напрямую:
npm run dev -w daly-schedule
```

## Правила платформы (обязательны для всех приложений)

1. **Один домен, приложения — роуты портала.** Всё живёт на
   `internal-apps.basementremodeling.com`: портал в корне, каждое приложение — путь
   (`/production-checklist`, `/checklists`, `/task-planner`, …). Субдомены, отдельные
   домены и отдельные бандлы под апки **не заводим** — апка это роут внутри портала.
2. **Одна база.** Общий Supabase-проект «HR DASHBOARD» (`pilxwhtkhysanpukaliu`) и общий
   `auth.users`. Если таблицы апки конфликтуют по именам с портальными — изолируем
   **префиксом** (так сделан Task Planner: `tp_*`), а не отдельным проектом.
3. **Доступ выдаёт только админ** — через роли и настройки доступа в портале
   (`applications` + роли пользователя). Приложение не заводит собственный контур допуска:
   ни «кому показывать карточку», ни «кого пускать на роут» оно не решает само.
   Проверка обязана быть и на UI (карточки/роуты), и в БД (RLS).
4. **Единый вход.** Пользователь логинится один раз в портале; отдельных экранов входа
   у приложений нет.
5. **Единая оболочка.** Хедер, бургер-меню и экран App Settings — общие, из портала:
   `Signed in as` → экраны текущей апки → `My Account` / `App Settings` /
   `My Applications` → `Sign out`; лого в хедере всегда ведёт на главную портала.
6. **Настройки апки — в БД, не в коде.** Вебхуки и параметры лежат в `app_settings`
   и правятся на `/settings/:appCode` (реестр — `apps/portal/src/app/appRegistry.ts`);
   env — только фолбэк.

> Правило 3 закрыто на обоих слоях: карточки фильтруются по ролям, роуты апок гейтятся
> (`AppAccessGuard` + `useAppAccess`, admin bypass, «Access denied»), а данные — RLS (все
> PII-таблицы скоупнуты `user_has_application_access`/`user_has_admin_role`). Детали и статус —
> `docs/PORTAL.md`.

## Принципы реализации
- **Код вместе.** Монореп держит приложения рядом и даёт общий `packages/ui` + `packages/lib`.
- **Деплой — статика за nginx на одном EC2** (см. `docs/DEPLOYMENT.md`): билд локально,
  rsync в webroot. CI нет — пуш в GitHub ничего не разворачивает.

## Приложения и оценка (см. docs/app-estimates)
| Приложение | Папка | Статус | Оценка |
|---|---|---|---|
| Task Planner (Daly Schedule) | `apps/task-planner` | код есть, доводка | ~5–6 дней |
| Платформа портала | `apps/portal` | **каркас построен** (Login/Grid/Users/Roles/Account + миграции), осталось: креды Supabase, Google OAuth, деплой | в составе ~3–4 дн |
| 06-HR-Checklists | `apps/hr-checklists` | плейсхолдер | оценён |
| 06-HR-Gmail Auto Sender | `apps/gmail-sender` | плейсхолдер | оценён |
| 02-Sales-Send an Offer Email | `apps/sales-offer` | плейсхолдер | оценён |
| 06-HR-Sync Airtable Contacts | `apps/hr-sync` | плейсхолдер | оценён |
| 03-Production-Checklist | `apps/production-checklist` | плейсхолдер | ~7.5 ч марж. (сиблинг HR-Checklists) |
