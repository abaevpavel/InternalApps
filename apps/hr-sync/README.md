# hr-sync

> 06-HR-SYNC AIRTABLE CONTACTS **живёт роутом внутри портала** (`apps/portal`) —
> `/hr-sync-airtable`. Карточка в портале: `applications.url = '/hr-sync-airtable'`.

Код:
- Страница: `apps/portal/src/pages/hr-sync/HRSyncAirtable.tsx`
- Сервис: `apps/portal/src/services/hr-sync.ts`

## Что делает
Две карточки — **Employee Contacts** и **Key Vendor Contacts**. У каждой кнопка **Sync** →
прямой POST в Make-вебхук (`{action:'sync_employees'|'sync_vendors'}`) → Make обновляет Airtable.
Вебхуки — в app-settings (`hr-sync` → `employees_webhook`/`vendors_webhook`), fallback env.

**БД/бакетов нет.** Автосинк живёт в 4 pg_cron-джобах (Employees 11:00/17:00 ET, Vendors
11:10/17:10 ET), которые сами дёргают Make через pg_net.

## Что работает / что нет (проверено на живой БД)
- ✅ **Кнопки Sync** — работают (реальный POST в Make).
- ✅ **Автосинк по расписанию** — работает (4 ручных cron-джобы в базе).
- ❌ **Save Schedule (редактирование времён из UI)** — НЕ работает. RPC `schedule_sync_job`/
  `unschedule_cron_job`/`get_sync_schedules` в базе **отсутствуют** (проверено: pg_proc пуст),
  оригинал ловил ошибку и рисовал фейковый «updated». В новой версии блок времён —
  **read-only** (реальное расписание), а «Save Schedule» — **disabled с hover-подсказкой**
  на английском, что не работает. Без вранья.

## Отклонения / рекомендации
- Времена показаны read-only (реальные из cron). Чтобы сделать редактируемым по-настоящему —
  своя таблица `sync_schedules` + рабочие cron-RPC + таймзона через IANA `America/New_York`
  (оригинал считал ET→UTC как +5, летом (EDT) уезжает на час).
- **Долг оригинала:** вебхуки публичные, без HMAC; нет role-gate. Рекомендация — edge-прокси
  с ролевой проверкой + секрет.

План/оценка: [docs/app-estimates/06-HR-Sync-Airtable-Contacts.md](../../docs/app-estimates/06-HR-Sync-Airtable-Contacts.md)
