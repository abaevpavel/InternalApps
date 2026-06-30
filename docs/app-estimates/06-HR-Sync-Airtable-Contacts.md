# 06-HR-Sync Airtable Contacts — план разработки и estimate

> Модель: **vibe-coding (билдит Claude), в ЧАСАХ.** Перенос «как есть» отдельно, дыры отдельно.
> Только Lovable-часть; сценарии Make + Airtable-маппинг — внешний движок, вне часов.

> ⚠️ **OVERLAP с 06-HR-Checklists.** Это приложение — тот же sync-механизм, что уже встроен
> в HR-Checklists: **тот же** edge function `manage-sync-schedules`, **те же** 2 Make-webhook,
> **тот же** pg_cron. Если оба строятся в одном портале — бэкенд (edge fn + RPC + cron + DST-фикс
> + защита webhook) делается **один раз**. См. «Итог и overlap».

---

## Что это
«Пульт» поверх Make: 2 карточки (Employee Contacts / Key Vendor Contacts), у каждой кнопка
Sync + 2 времени автозапуска (ET) + Save Schedule. Sync → прямой POST в Make-webhook; Make сам
пишет контакты в Airtable. Save Schedule → edge function пересоздаёт 2 pg_cron job, которые
бьют в тот же webhook дважды в день. **Своих таблиц нет**, Airtable-логики в коде нет.

**Сложность: тривиальная** (на фронте). Вся «мякоть» — в pg_cron + pg_net + 3 SECURITY DEFINER RPC.

## Простыми словами: кто что делает
- **HR** — жмёт «Sync» вручную, либо задаёт 2 времени в день и жмёт «Save Schedule».
- **Приложение** — по кнопке пинает Make; по «Save Schedule» просит свою функцию поставить
  расписание.
- **Edge function** — заводит «будильники» в базе (pg_cron) на заданное время.
- **«Будильник» базы (cron)** — сам, в нужный момент, пинает тот же Make (без участия человека).
- **Make (отдельно)** — выгружает контакты сотрудников/вендоров в Airtable.
- **Airtable** — итоговая таблица контактов.
> Главное: приложение — это просто **«пульт с кнопками и таймером»**. Саму выгрузку контактов
> делает Make; в коде приложения никакого Airtable нет.

---

## Архитектура (как сейчас)
```
[/hr-sync-airtable] 2 карточки
  Sync (ручной) → fetch POST → Make webhook {action: sync_employees|sync_vendors}
  Save Schedule → invoke('manage-sync-schedules', {type, time1, time2})
        → ET→UTC (жёстко +5, без DST) → пересоздаёт 2 pg_cron job
        → cron: net.http_post → тот же Make webhook {action:…, scheduled:true}
[нет своих таблиц; состояние расписания живёт только в cron.job]
```

---

## Перенос «как есть» (≈2.25 ч)
| # | Блок | Состав | Часы |
|---|------|--------|------|
| 1 | **2 карточки UI** | страница, Employees/Vendors, 2 sync-кнопки, 4 time-picker, 2 Save Schedule | 0.75 |
| 2 | **Sync → Make** | прямой POST в 2 webhook (как есть) | 0.25 |
| 3 | **Edge + RPC + cron** | `manage-sync-schedules` (GET/POST) + 3 SECURITY DEFINER RPC (`schedule_sync_job`/`unschedule_cron_job`/`get_sync_schedules`) + pg_cron/pg_net, ET→UTC (как есть) | 1.0 |
| 4 | **Portal-wiring + QA + деплой** | строка в `applications`, прогон | 0.25 |
| | **Итого перенос** | | **≈ 2.25 ч** |

**Вилка переноса:** пол ~1.75 · реалистично ~2.25 · с трением ~3.5 (трение всё — в pg_cron/pg_net/SECURITY DEFINER: расширения, права, отладка net.http_post).

---

## Дыры / исправления (отдельно, поверх переноса)
| # | Дыра | Суть / чем грозит | Фикс | Prio | Часы |
|---|------|-------------------|------|------|------|
| F1 | **DST не учитывается** | ET→UTC жёстко +5; летом (EDT) cron уезжает на час | `timezone('America/New_York', …)` вместо ручного +5 | P1 | 0.5 |
| F2 | **UI не подгружает реальное расписание** | GET-ручка есть, но фронт её не зовёт → time-picker'ы всегда показывают константы 11:00/17:00, а не то, что в cron | вызвать GET `manage-sync-schedules` на маунте, заполнить поля | **P1** | 0.4 |
| F3 | **Открытые Make-webhook из браузера** | URL в bundle, POST без auth → кто знает URL, триггерит синк | единая edge `trigger-hr-sync` с подписью `MAKE_WEBHOOK_SECRET` (HMAC), фронт+cron бьют сюда | **P0** | 1.0 |
| F4 | **`manage-sync-schedules` без JWT/role-check** | использует service_role, деплоится с дефолтом проекта → кто знает URL, переписывает чужой cron | JWT + проверка роли (Admin/HR-Lead) + валидация input | **P1** | 0.3 |
| F5 | **Имена job не уникальны + врут** | `sync-employees-11am` фиксированы → перезапишет кто угодно; `-11am/-5pm` не отражают реальное время | имена от типа без времени; (опц.) скоуп на арендатора | P2 | 0.25 |
| F6 | **Нет debounce на Sync** | между запросами защиты нет → дабл-вызов синка | loading/disable сразу при клике | P2 | 0.15 |
| F7 | **Нет состояния/аудита** *(фича-гэп)* | нет `last_synced_at`/истории → не видно, прошёл ли вчерашний автосинк | таблицы `sync_schedules` (состояние) + `sync_runs` (аудит) + лог из trigger-edge | опц. | 1.0 |
| | **Итого исправления** | | | | **≈ 2.6 ч** (+1 опц. F7) |

> Суть долга: **webhook открыт** (F3) + **функция расписания открыта** (F4) + **UI врёт про
> расписание** (F2) + **DST уезжает** (F1). Безопасный минимум F1+F2+F3+F4 ≈ 2.2 ч.
> F1/F3/F4 **совпадают** с фиксами HR-Checklists (общий бэкенд).

---

## Итог и overlap
**Standalone: перенос ~2.25 ч + исправления ~2.6 ч ≈ 4.85 ч** (+1 опц.).

**Если строится вместе с 06-HR-Checklists** (общий `manage-sync-schedules` + cron + webhooks +
их фиксы DST/безопасность делаются один раз) — **маржинальная стоимость этого app ≈ 1.5 ч**
(только 2 карточки UI + portal-wiring; бэкенд и фиксы уже сделаны в Checklists).

> Для суммы по порталу берём **маржинальные ~1.5 ч**, а не standalone ~4.85, чтобы не задвоить
> общий sync-бэкенд.

---

## Контракты и факты (из разбора Lovable + скрин)
- **Make webhooks:** Employees `hook.us1.make.com/083dd6f…` · Vendors `…/c7njtsv…`; POST JSON
  `{action:"sync_employees|sync_vendors"[, "scheduled":true]}`. Без авторизации.
- **pg_cron (как есть):** `sync-employees-11am` `0 16 * * *`, `-5pm` `0 22 * * *`,
  `sync-vendors-11am` `10 16 * * *`, `-5pm` `10 22 * * *` (UTC, EST без DST).
- **Edge:** `manage-sync-schedules` (GET/POST), использует `SERVICE_ROLE_KEY`, RPC
  `schedule_sync_job`/`unschedule_cron_job`/`get_sync_schedules` (SECURITY DEFINER, из миграций).
- **БД:** своих таблиц нет; состояние расписания — только в `cron.job`. Нет `last_synced_at`/истории.
- **Secrets:** только `SUPABASE_URL`/`SERVICE_ROLE_KEY`. `MAKE_WEBHOOK_SECRET` в проекте есть, тут НЕ применяется.
- **Airtable:** в коде UNKNOWN (base/table/маппинг — в Make; direction push HR→Airtable).
- **Current-state:** работают ручной Sync и Save Schedule (cron реально стреляет). Проблемы: DST, UI не грузит расписание, открытые webhook, неуникальные job-имена, нет debounce/аудита.

---

## Допущения и границы
- **Вне scope:** сценарии Make (HR→Airtable маппинг, идемпотентность) и Airtable-база.
- Перенос — 1:1 как есть (жёсткий +5, прямой webhook, UI на константах). Улучшения — в «Дырах».
- Общий sync-бэкенд с HR-Checklists — считать один раз (см. overlap).
