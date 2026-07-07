# sales-offer

> 02-SALES-SEND AN OFFER EMAIL **живёт роутом внутри портала** (`apps/portal`) —
> `/sales-email-sender`. Карточка в портале: `applications.url = '/sales-email-sender'`.

Код:
- Страница: `apps/portal/src/pages/sales/SalesEmailSender.tsx` (+ `DatePicker.tsx`)
- Сервис: `apps/portal/src/services/sales.ts`

## Что делает
Композер письма-предложения для отдела продаж: тема, до 3 дат встречи, **ричтекст-редактор**
(Quill / react-quill-new, полный тулбар), отправитель + имя. Умеет:
- **Шаблоны** (`email_templates`): Save as New / Update / Load / Rename / Delete.
- **Черновик** в `localStorage` (7 ключей `sales-email-*`), восстанавливается после перезагрузки.
- **Send Email** → чистит HTML regex'ами → POST в make-вебхук (`subject, htmlContent, date1..3,
  sendFrom, senderName`). Make дальше рассылает по списку из Airtable. Доставку приложение не видит.
- Все действия — через модалки-подтверждения.

**Одна таблица** `email_templates`. Бакетов/edge-функций нет. Даты в письме — per-send, в шаблоне
не хранятся.

## Env
- `VITE_MAKE_SALES_OFFER_WEBHOOK` — вебхук рассылки (`hook.us1.make.com/413vwl0…`).

## Отклонения от оригинала / долги
- `updated_at` в оригинале не обновлялся — тут **проставляю явно** при update/rename.
- Добавил **валидацию формата email** (в оригинале — только непустота).
- **Долги оригинала (перенос как есть):** RLS на `email_templates` слишком свободные (любой
  authenticated может править/удалять чужие шаблоны — рекомендация: owner-only на UPDATE/DELETE
  либо роль Sales); вебхук зашит в клиенте без подписи (рекомендация: edge-прокси `send-sales-offer`
  + secret + HMAC + лог отправок). «Отправка» = fire-and-forget POST, доставка не отслеживается.

План/оценка: [docs/app-estimates/02-Sales-Send-Offer-Email.md](../../docs/app-estimates/02-Sales-Send-Offer-Email.md)
