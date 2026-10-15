import { PageTitle } from '../../components/task-planner-ui'
import { HistoryPanel } from '../../components/HistoryPanel'

/**
 * История изменений Task Planner (миграция 0034): задачи, фото, бригады, справочники,
 * настройки — кто, когда и что поменял, люди и автоматика. Пишет триггер в базе.
 */
export function HistoryPage() {
  return (
    <div>
      <PageTitle title="History" subtitle="Every change to tasks, crews, directories and settings — by people and by automation." />
      {/* По умолчанию — только правки людей: синки с Airtable пишут много и заслоняют их. */}
      <HistoryPanel appUrl="/task-planner" defaultPeopleOnly />
    </div>
  )
}
