import { useSearchParams } from 'react-router-dom'
import { PageTitle, Tabs } from '../../components/ui'
import snapshot from '../../data/make-catalog.json'
import type { CatalogSnapshot } from '../../domain/make-catalog'
import { EmailsTab } from './EmailsTab'
import { PayloadsTab } from './PayloadsTab'

/**
 * Dev Apps — инструменты разработчика (BAS-1556, BAS-1503/1504). Доступ — роли Developer и Admin.
 * Данные — снимок JSON в репо, собранный из блюпринтов Make (только чтение).
 */
const TABS = [
  { key: 'emails', label: 'Emails' },
  { key: 'payloads', label: 'Payloads' },
] as const
type TabKey = (typeof TABS)[number]['key']

const catalog = snapshot as CatalogSnapshot

export function DevAppsPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'emails'

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 pb-24 sm:px-6">
      <PageTitle
        title="Dev Apps"
        subtitle={
          catalog.generatedAt
            ? `Make sales chain — snapshot of ${new Date(catalog.generatedAt).toLocaleString('en-US')}, read from the live blueprints.`
            : 'Make sales chain — the snapshot has not been built yet.'
        }
      />
      <Tabs
        className="mb-6 max-w-sm"
        tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
        value={tab}
        onChange={(k) => setParams(k === 'emails' ? {} : { tab: k }, { replace: true })}
      />
      {tab === 'emails' ? <EmailsTab catalog={catalog} /> : <PayloadsTab catalog={catalog} />}
    </div>
  )
}
