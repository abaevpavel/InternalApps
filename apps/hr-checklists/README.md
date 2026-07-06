# hr-checklists

> 06-HR-CHECKLISTS **живёт роутами внутри портала** (`apps/portal`), а не как отдельная
> апка — делит ту же Supabase (`pilxwhtkhysanpukaliu`) и деплой с порталом
> (как и production-checklist). Отдельный только task-planner (своя БД).

Код:
- Страницы: `apps/portal/src/pages/hr-checklists/*`
- Домен: `apps/portal/src/domain/hr-checklists.ts`
- Сервис: `apps/portal/src/services/hr-checklists.ts`
- Роуты: `/checklists` (сотрудники + назначения + прохождение), `/checklist/:id` (редактор шаблона)
- Карточка в портале: `applications.name = '06-HR-Checklists'`, `url = '/checklists'`

## Что реализовано
- **Сотрудники**: создание (First/Last/Type/даты), поисковый комбобокс.
- **Шаблоны** (`checklists` + `checklist_items`, иерархия ≥3 уровней): создание/дублирование/удаление,
  редактор с dnd-сортировкой и indent/outdent, edit-диалог (links UPPERCASE+https, ≤10 answer_options,
  фото), Preview, **AI-импорт из картинки** (edge `extract-checklist-from-image`, `table:'checklist_items'`).
- **Назначение** шаблонов сотруднику (`employee_checklists`), прохождение: **tri-state** (unchecked/checked/N/A)
  с каскадом родитель→листья, выбор ответа, **заметки+фото на задаче** и **общие заметки** на назначении,
  авто-сворачивание при 100%.
- **PDF-отчёт** по сотруднику (`@react-pdf/renderer`): пункты + статус [ ]/[x]/[N/A] + «Completed By» + дата.
- Фото жмутся в JPEG ≤200KB (`lib/imageCompression.ts`), бакеты `checklist-item-photos` / `checklist-photos`.

## Сознательные отклонения от оригинала (рекомендации по фиксу)
- **Legacy-фазы `phase1/2a/2b/3` (hardcoded для Office employee) — НЕ перенесены.** Они были вшиты
  в код страницы, legacy и почти не использовались (`employee_phase_preferences` ~1 строка). При
  необходимости их контент заводится обычными шаблонами через редактор. Таблица
  `employee_phase_preferences` и перегрузка колонки `phase` (имя фазы vs checklistId) в новой версии
  не нужны — для динамических чек-листов `phase = checklist_id`.
- **Каскад tri-state**: родитель каскадит состояние на все листья; состояние родителя — производное
  от листьев (не хранится отдельной строкой прогресса). Проще и без гонок оригинала.
- **Вложенность в редакторе**: кнопки indent/outdent вместо hover-500ms + Shift-nest оригинала.
- **Приватность**: бакеты фото публичные (как в оригинале). Рекомендация — приватные + signed URLs.
- **Нет DB-UNIQUE** на `employee_checklists(employee_id,checklist_id)` и прогрессе — назначение
  защищено проверкой в коде; прогресс — read-then-write по (employee_id, task_id, phase).

План/оценка: [docs/app-estimates/06-HR-Checklists.md](../../docs/app-estimates/06-HR-Checklists.md)
