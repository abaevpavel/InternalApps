import { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Card, Input, StatusBadge } from '../../components/ui'
import { cn } from '../../lib/utils'
import { STAGES, makeVariables, previewHtml, type CatalogSnapshot, type EmailEntry, type ScenarioEntry, type StageKey } from '../../domain/make-catalog'

/**
 * Все письма, которые отправляют сценарии Make цепочки продаж (BAS-1556): по этапам, со
 * сценарием, условием отправки, адресатами, темой и превью тела с подсвеченными переменными.
 */
export function EmailsTab({ catalog }: { catalog: CatalogSnapshot }) {
  const [stage, setStage] = useState<StageKey | 'all'>('all')
  const [search, setSearch] = useState('')

  const needle = search.trim().toLowerCase()
  const matches = (s: ScenarioEntry, e: EmailEntry) =>
    !needle ||
    [s.name, e.subject, e.from ?? '', ...e.to, ...e.cc, ...e.bcc, e.condition ?? ''].some((x) => x.toLowerCase().includes(needle))

  const groups = useMemo(
    () =>
      STAGES.filter((st) => stage === 'all' || st.key === stage)
        .map((st) => ({
          stage: st,
          scenarios: catalog.scenarios
            .filter((s) => s.stage === st.key)
            .map((s) => ({ scenario: s, emails: s.emails.filter((e) => matches(s, e)) }))
            .filter((x) => x.emails.length > 0),
        }))
        .filter((g) => g.scenarios.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, stage, needle],
  )

  const total = catalog.scenarios.reduce((n, s) => n + s.emails.length, 0)

  if (!catalog.generatedAt) {
    return <p className="text-sm text-gray-500">The email catalogue is empty until the snapshot is built from the Make blueprints.</p>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StageChip active={stage === 'all'} onClick={() => setStage('all')}>All · {total}</StageChip>
        {STAGES.map((st) => {
          const n = catalog.scenarios.filter((s) => s.stage === st.key).reduce((k, s) => k + s.emails.length, 0)
          return n ? (
            <StageChip key={st.key} active={stage === st.key} onClick={() => setStage(st.key)}>
              {st.label} · {n}
            </StageChip>
          ) : null
        })}
        <Input className="ml-auto max-w-xs" placeholder="Search subject, recipient, scenario" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {groups.length === 0 && <p className="text-sm text-gray-500">Nothing matches.</p>}

      {groups.map((g) => (
        <section key={g.stage.key}>
          <h2 className="mb-2 text-base font-semibold text-gray-900">{g.stage.label}</h2>
          <div className="space-y-3">
            {g.scenarios.map(({ scenario, emails }) => (
              <Card key={scenario.id} className="p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-gray-900">{scenario.name}</span>
                  <span className="font-mono text-xs text-gray-400">#{scenario.id}</span>
                  {!scenario.active && <StatusBadge tone="neutral">off</StatusBadge>}
                  <a href={scenario.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
                    Open in Make <ExternalLink size={12} />
                  </a>
                </div>
                <div className="divide-y divide-gray-100">
                  {emails.map((e) => <EmailRow key={e.moduleId} email={e} />)}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function StageChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded-full border px-3 py-1 text-xs', active ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}
    >
      {children}
    </button>
  )
}

function EmailRow({ email: e }: { email: EmailEntry }) {
  const [open, setOpen] = useState(false)
  const vars = makeVariables(`${e.subject} ${e.bodyHtml}`)
  return (
    <div className="py-2 text-sm">
      <button type="button" className="flex w-full flex-wrap items-baseline gap-x-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="font-medium text-gray-900">{e.subject || '(no subject)'}</span>
        <span className="text-xs text-gray-500">→ {e.to.join(', ') || '—'}</span>
        <span className="ml-auto font-mono text-[11px] text-gray-400">module {e.moduleId}</span>
      </button>
      {e.condition && <p className="mt-0.5 text-xs text-gray-500">When: {e.condition}</p>}
      {open && (
        <div className="mt-2 space-y-2">
          <dl className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[80px_minmax(0,1fr)]">
            <Row label="Module" value={e.module} mono />
            <Row label="From" value={e.from} />
            <Row label="To" value={e.to.join(', ')} />
            <Row label="CC" value={e.cc.join(', ')} />
            <Row label="BCC" value={e.bcc.join(', ')} />
            <Row label="Reply-to" value={e.replyTo} />
            <Row label="Attached" value={e.attachments.join(', ')} />
          </dl>
          {vars.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {vars.map((v) => <code key={v} className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-900">{v}</code>)}
            </div>
          )}
          {/* sandbox без разрешений: HTML письма не может выполнить скрипт или уйти по ссылке. */}
          <iframe title={`Email ${e.moduleId}`} sandbox="" srcDoc={previewHtml(e.bodyHtml)} className="h-80 w-full rounded-lg border border-gray-200 bg-white" />
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null
  return (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd className={cn('text-gray-800 [overflow-wrap:anywhere]', mono && 'font-mono')}>{value}</dd>
    </>
  )
}
