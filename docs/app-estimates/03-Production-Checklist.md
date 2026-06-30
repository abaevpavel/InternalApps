# 03-Production-Checklist — план разработки и estimate

> Модель: **vibe-coding (билдит Claude), в ЧАСАХ.** Перенос «как есть» (чистый rebuild), дыры отдельно.

## Простыми словами: кто что делает
- **PM / прораб** — открывает проект, идёт по QA-чеклисту (Yes/No/N/A + заметки), жмёт Send.
- **Приложение** — хранит шаблоны и прогресс по проектам; по Send шлёт payload в Make и помечает проект `Completed`.
- **Make (отдельно)** — заводит проекты в приложение (входящий вебхук) и принимает финальный чеклист (исходящий). Buildertrend — вероятно через Make (в коде прямой связи нет).
- **База (Supabase)** — projects, шаблоны, прогресс по проектам.
> Главное: это **сиблинг HR-Checklists, но для проектов, а не сотрудников**. Тот же паттерн
> чек-листов (иерархия, dnd-редактор, AI-импорт), но проще: без PDF, без фаз, dnd уже на dnd-kit.

---

## Чем отличается от HR-Checklists (важно для оценки)
| | HR-Checklists | Production-Checklist |
|---|---|---|
| Сущность | сотрудник (+ типы, фазы) | проект |
| Размер | ~8000 строк | ~2100 строк (3 страницы + диалоги) |
| DnD | ручной (~150 строк) | ✅ уже на **dnd-kit** |
| PDF-экспорт | да | ❌ нет |
| Фото-потоки | два (пункт + чек-лист) | один (фото пунктов шаблона) |
| Legacy | ~1500 строк мёртвого | ❌ чисто |
| Make-интеграция | ❌ нет | ✅ вход (`create-project-webhook`) + выход (Send) |
| **Общий код** | PhotoUploadDialog, `extract-checklist-from-image`, UI-примитивы | **те же** → в монорепе переиспользуем |

---

## Scope (что строим)
- **3 экрана:** `/production-checklist` (Projects + Templates, фильтры, прогресс-бэйджи, per-row Open/Send/Edit/Delete),
  `/production-checklist/:id` (редактор шаблона: dnd-kit дерево, inline, edit-dialog links/photos/answer_options, preview, AI-импорт),
  `/production-checklist/project/:projectId` (заполнение по проекту: Yes/No/N/A, автосейв debounce 600мс, прогресс-бар, read-only когда `Completed`).
- **БД:** 5 таблиц (`projects`, `production_checklists`, `production_checklist_items` self-FK, `project_checklists` (UNIQUE project_id), `project_checklist_progress` (UNIQUE project_id+task_id)) + enum `project_status`.
- **Storage:** 1 бакет `production-checklist-photos` (→ приватный + signed URLs).
- **Edge functions:** `create-project-webhook` (HMAC, insert project + линк дефолт-шаблона), `send-checklist-to-make` (серверная валидация + HMAC + идемпотентность), `extract-checklist-from-image` (общая).
- **Auth/роли:** Admin + доступ через `role_applications('/production-checklist')`.

---

## Перенос «как есть» (план, ≈13 ч standalone)
| # | Сессия | Состав | Часы |
|---|--------|--------|------|
| 1 | **Каркас + БД** | 5 таблиц + миграции + констрейнты (UNIQUE project_id, project_id+task_id) + enum `project_status` | 1.5 |
| 2 | **RLS + access + 🔒 private bucket** | политики Admin/app-access; приватный бакет + signed URLs | 1.5 |
| 3 | **Главная** | вкладки Projects/Templates, фильтры, сортировка, прогресс-бэйджи (done/total/Sent), per-row actions + confirm | 1.5 |
| 4 | **Редактор шаблона** | dnd-kit дерево, inline-edit, edit-dialog (links/photos/answer_options), preview | 2.5 |
| 5 | **Заполнение по проекту** | Yes/No/N/A, автосейв debounce, прогресс-бар (leaf-only), read-only при Completed | 2.0 |
| 6 | **AI-импорт** | edge `extract-checklist-from-image` (общая) + UI | 1.0 |
| 7 | **create-project-webhook** | HMAC `x-webhook-secret`, insert project, линк **дефолт-шаблона** (не всех) | 1.0 |
| 8 | **send-checklist-to-make** | серверная валидация + HMAC к Make + идемпотентность по `checklist_sent_at` | 1.0 |
| 9 | **QA + деплой** | edge-кейсы, прод-деплой | 1.0 |
| | **Итого standalone** | | **≈ 13 ч** |

**Вилка:** пол ~10 · реалистично ~13 · с трением ~16.

### 🔑 Маржинально (если строится ПОСЛЕ HR-Checklists в монорепе) — **~7.5 ч**
HR-Checklists первым выносит в `packages/ui` общие куски: **чек-лист-редактор (dnd-kit дерево),
item-edit-dialog (links/photos/answer_options), PhotoUpload, UI AI-импорта**. Тогда у Production
остаётся только своё: страница заполнения по проекту, главная Projects/Templates, 2 Make-edge,
схема projects. **Сессии 4 и 6 почти бесплатны** → маржинальная стоимость ≈ **7.5 ч**.

---

## Дыры / критичные находки (из аудита)
| # | Находка | Суть / чем грозит | Где решаем |
|---|---------|-------------------|-----------|
| 🔴 SEC1 | **Публичный бакет** | фото стройплощадок без авторизации | приватный + signed URLs (сессия 2) |
| 🔴 SEC2 | **Открытый Make-webhook из браузера** | Send напрямую из клиента, без HMAC/идемпотентности → можно слать payload и дубли | серверный `send-checklist-to-make` (сессия 8) |
| F1 | **Автолинк ВСЕХ шаблонов к проекту** | `create-project-webhook` цепляет все `production_checklists` → при >1 шаблоне дубли назначений | линковать только дефолт-шаблон (сессия 7) |
| F2 | **Нет UNIQUE на project_checklists** | гонка при двойном клике → дубль назначения | UNIQUE project_id (сессия 1) |
| F3 | **Дубль Send-логики** | два независимых fetch к Make (главная + страница проекта) | один путь через edge (сессия 8) |
| F4 | **status — text, не enum** | принимает что угодно из Make, фильтр UI теряет значения | enum `project_status` (сессия 1) |
| F5 | **Мёртвая колонка `progress.photos`** | в форме заполнения фото не пишутся | либо реализовать upload, либо дропнуть колонку |

> Почти все закрываются чистым rebuild. Обязательны SEC1+SEC2 (приватность + безопасный Send) —
> они уже в часах переноса (сессии 2 и 8).

---

## Контракты и факты (из аудита)
- **Make outbound:** `https://hook.us1.make.com/4kvdv09riqpiz2e7uhnitjflic3q9bv4`, POST, payload `{payload_from, sent_at, project, checklist, items[]}`. Без auth.
- **Make inbound → `create-project-webhook`:** заголовок `x-webhook-secret` = `MAKE_WEBHOOK_SECRET`; insert в `projects` через service role; затем линкует шаблоны.
- **Buildertrend:** прямой связи в коде нет — вероятно Buildertrend → Make → `create-project-webhook` (UNKNOWN, смотреть Make).
- **Объёмы:** projects 10, production_checklists 1, production_checklist_items 23 (depth 2, макс 9 детей), project_checklists 10, project_checklist_progress 205. Малые — нагрузки нет.
- **Secrets:** `MAKE_WEBHOOK_SECRET`, `SUPABASE_*`, `LOVABLE_API_KEY`. Make-URL зашит в коде.

---

## Итог
- **Standalone: ~13 ч.**
- **Маржинально после HR-Checklists (монореп, общие компоненты): ~7.5 ч.** ← берём для суммы портала.
- Buildertrend — через Make, вне часов; внутренности Make-сценария — вне scope.
