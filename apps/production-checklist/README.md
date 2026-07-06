# production-checklist

> 03-PRODUCTION-CHECKLIST **живёт роутами внутри портала** (`apps/portal`), а не как
> отдельная апка — потому что делит ту же Supabase (`pilxwhtkhysanpukaliu`) и деплой с порталом.
> (Отдельная только task-planner — у неё своя БД.)

Код:
- Страницы: `apps/portal/src/pages/production-checklist/*`
- Домен: `apps/portal/src/domain/production-checklist.ts`
- Сервис: `apps/portal/src/services/production-checklist.ts`
- Роуты: `/production-checklist`, `/production-checklist/:id`, `/production-checklist/project/:projectId`

Карточка в портале («My Applications») открывает приложение внутренней навигацией — для этого
в таблице `applications` у строки `production-checklist` поле `url` должно быть относительным
путём `'/production-checklist'` (см. SQL в PR/чате). План/оценка:
[docs/app-estimates/03-Production-Checklist.md](../../docs/app-estimates/03-Production-Checklist.md)
