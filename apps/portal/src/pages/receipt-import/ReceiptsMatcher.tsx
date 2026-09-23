import { useSearchParams } from 'react-router-dom'
import { PageTitle, Tabs } from '../../components/ui'
import { ImportTab } from './ReceiptImport'
import { NotificationsTab } from './NotificationsTab'
import { PromptsTab } from './PromptsTab'
import { CardsTab } from './CardsTab'
import { HistoryPanel } from '../../components/HistoryPanel'

/**
 * 07 Finances — Receipts Matcher: оболочка апки на `/receipt-import`.
 *
 * Все экраны — вкладками одной апки, потому что у них одно правило доступа
 * (`user_has_application_access(auth.uid(), '/receipt-import')`): импорт (BAS-1450),
 * получатели уведомлений (BAS-1474), промпты AI (BAS-1473), сотрудники и карты (BAS-1472).
 * Активная вкладка — в `?tab=`, чтобы ссылка открывала нужную.
 */
const TABS = [
  { key: 'import', label: 'Import transactions' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'cards', label: 'Employees & cards' },
  { key: 'prompts', label: 'AI prompts' },
  { key: 'history', label: 'History' },
] as const

type TabKey = (typeof TABS)[number]['key']

export function ReceiptsMatcherPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'import'

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-10 pb-32 sm:px-6">
      <PageTitle title="Receipts Matcher" />
      <Tabs
        className="mb-6 max-w-3xl"
        tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
        value={tab}
        onChange={(k) => setParams(k === 'import' ? {} : { tab: k }, { replace: true })}
      />
      {tab === 'import' && <ImportTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'cards' && <CardsTab />}
      {tab === 'prompts' && <PromptsTab />}
      {tab === 'history' && <HistoryPanel appUrl="/receipt-import" />}
    </div>
  )
}
