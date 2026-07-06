# gmail-sender

> 06-HR-GMAIL AUTO SENDER **живёт роутом внутри портала** (`apps/portal`) —
> `/gmail-auto-sender`. Карточка в портале: `applications.url = '/gmail-auto-sender'`.

Код:
- Страница: `apps/portal/src/pages/gmail-sender/GmailAutoSender.tsx`
- Сервис: `apps/portal/src/services/gmail-auth.ts`

## Что делает
Одна форма: ввод email сотрудника → **Setup Gmail Auth** → вызов существующей edge-функции
`gmail-auth` (та же Supabase `pilxwhtkhysanpukaliu`) → та проксирует в AWS API Gateway и
возвращает Google OAuth consent URL → фронт открывает его в новой вкладке. Плюс инструкционные
плитки «What to expect during Gmail authorization» (Google warning воссоздан на HTML/CSS, без PNG).

**БД/Storage — нет.** Токены и состояние живут на стороне AWS. Приложение — тонкий фронт над
уже задеплоенной edge-функцией.

## Долг (в edge-функции, не трогаем — «перенос как есть»)
`gmail-auth` имеет `verify_jwt=false` и **захардкоженный** AWS-URL + токен `bmasters2020` →
открытый прокси: кто знает URL функции, может дёргать AWS от имени проекта. Рекомендация —
вынести `AWS_GMAIL_AUTH_URL`/`AWS_GMAIL_AUTH_TOKEN` в secrets, включить `verify_jwt=true` +
admin-check. Вся серьёзная часть (Google Cloud OAuth client, Gmail scopes, Lambda для
`/gmail/auth` и `/gmail/callback`, хранение refresh_token, рассыльщик) — на стороне AWS, вне портала.

План/оценка: [docs/app-estimates/06-HR-Gmail-Auto-Sender.md](../../docs/app-estimates/06-HR-Gmail-Auto-Sender.md)
