# InternalApps — монорепозиторий внутренних приложений basementremodeling.com

Один репозиторий, несколько независимых приложений. Бэкенд у приложений — **Supabase**
(каждое может иметь свой проект); фронты — Vite + React + TS SPA, деплой — отдельные
статические сайты на **AWS** (на домене клиента, по субдоменам).

## Структура
```
apps/
  portal/                Платформа: My Applications + User Management + Roles. [плейсхолдер]
  task-planner/          Daly Schedule — планировщик бригад (идёт доводка). Свой Supabase «crews scheduling».
  hr-checklists/         06-HR-Checklists. [плейсхолдер]
  gmail-sender/          06-HR-Gmail Auto Sender. [плейсхолдер]
  sales-offer/           02-Sales-Send an Offer Email. [плейсхолдер]
  hr-sync/               06-HR-Sync Airtable Contacts. [плейсхолдер]
  production-checklist/  03-Production-Checklist. [плейсхолдер, ещё не оценён]
packages/
  ui/                    Общий дизайн-система, лого, shadcn-компоненты. [плейсхолдер]
  lib/                   Общий Supabase-клиент, errMsg, типы. [плейсхолдер]
docs/
  app-estimates/         Планы и оценки по каждому приложению.
  SPEC / AUDIT / MIGRATION / AI-MODULES  — спецификации и аудит.
```

## Workspaces (npm)
```bash
npm install                      # ставит зависимости всех apps/packages
npm run dev:task-planner         # дев-сервер Task Planner
npm run build:task-planner       # прод-сборка Task Planner
# или напрямую:
npm run dev -w daly-schedule
```

## Принципы
- **Код вместе, базы раздельно по логике.** Монореп держит приложения рядом и даёт общий
  `packages/ui` + `packages/lib`; Supabase-проекты у приложений могут быть разными
  (Task Planner — отдельный, портал-апки — общий портал-Supabase).
- **Деплой независимый по апке.** Каждое приложение билдится и хостится отдельным статическим
  сайтом (AWS Amplify или S3+CloudFront), свой субдомен на домене клиента.
- Платформа портала решает «кого пускать и какие карточки показывать»; роли/RLS внутри
  каждого приложения — отдельно.

## Приложения и оценка (см. docs/app-estimates)
| Приложение | Папка | Статус | Оценка |
|---|---|---|---|
| Task Planner (Daly Schedule) | `apps/task-planner` | код есть, доводка | ~5–6 дней |
| Платформа портала | `apps/portal` | плейсхолдер | в составе ~3–4 дн |
| 06-HR-Checklists | `apps/hr-checklists` | плейсхолдер | оценён |
| 06-HR-Gmail Auto Sender | `apps/gmail-sender` | плейсхолдер | оценён |
| 02-Sales-Send an Offer Email | `apps/sales-offer` | плейсхолдер | оценён |
| 06-HR-Sync Airtable Contacts | `apps/hr-sync` | плейсхолдер | оценён |
| 03-Production-Checklist | `apps/production-checklist` | плейсхолдер | ⚠️ ещё НЕ оценён |
