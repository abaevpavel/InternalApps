import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { Card, Input } from '../../components/ui'
import { cn } from '../../lib/utils'
import snapshot from '../../data/airtable-schema.json'
import { matchesField, typeLabel, type AirtableField, type AirtableSnapshot, type FieldFilter } from '../../domain/airtable-schema'

const schema = snapshot as AirtableSnapshot

const FILTERS: { key: FieldFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'input', label: 'Entered by hand' },
  { key: 'computed', label: 'Computed' },
  { key: 'junk', label: 'Looks like junk' },
]

/**
 * Все атрибуты Lead / Opportunity / Project в Airtable: таблицы двух base и их поля — тип,
 * вводится руками или вычисляется, формула, варианты, куда ссылается. Только структура.
 * Выбранная таблица — в ?table=, чтобы ссылкой можно было поделиться.
 */
export function AirtableTab() {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<FieldFilter>('all')
  const [search, setSearch] = useState('')

  const all = schema.bases.flatMap((b) => b.tables.map((t) => ({ base: b, table: t })))
  const current = all.find((x) => x.table.id === params.get('table')) ?? all[0]
  const pick = (id: string) => setParams({ tab: 'airtable', table: id }, { replace: true })

  const needle = search.trim()
  const fields = useMemo(
    () => current.table.fields.filter((f) => matchesField(f, filter, needle)),
    [current, filter, needle],
  )
  const computed = current.table.fields.filter((f) => f.computed).length
  const junk = current.table.fields.filter((f) => f.junk).length

  return (
    <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <nav className="space-y-4 text-sm">
        <p className="text-xs text-gray-400">Schema of {new Date(schema.generatedAt).toLocaleDateString('en-US')} — structure only, no records.</p>
        {schema.bases.map((b) => (
          <div key={b.id}>
            <a href={b.url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-800">
              {b.name} <ExternalLink size={11} />
            </a>
            <div className="space-y-0.5">
              {b.tables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t.id)}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left',
                    t.id === current.table.id ? 'bg-blue-50 text-blue-800' : 'text-gray-700 hover:bg-gray-50',
                    !t.role && 'text-gray-500',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t.name}
                    {t.role && <span className="block text-[11px] text-gray-400">{t.role}</span>}
                  </span>
                  <span className="text-[11px] text-gray-400">{t.fields.length}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold text-gray-900">{current.table.name}</h2>
          {current.table.role && <span className="text-sm text-gray-500">{current.table.role}</span>}
          <span className="text-xs text-gray-400">
            {current.base.name} · {current.table.id} · {current.table.fields.length} fields · {current.table.fields.length - computed} by hand ·{' '}
            {computed} computed{junk ? ` · ${junk} look like junk` : ''}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn('rounded-full border px-3 py-1 text-xs', filter === f.key ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}
            >
              {f.label}
            </button>
          ))}
          <Input className="ml-auto max-w-xs" placeholder="Search name, formula, option" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
                <th className="px-3 py-2 font-normal">Field</th>
                <th className="px-3 py-2 font-normal">Type</th>
                <th className="px-3 py-2 font-normal">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fields.map((f) => (
                <FieldRow key={f.id} field={f} onOpenTable={pick} />
              ))}
            </tbody>
          </table>
          {fields.length === 0 && <p className="px-3 py-4 text-sm text-gray-500">Nothing matches.</p>}
        </Card>
      </div>
    </div>
  )
}

function FieldRow({ field: f, onOpenTable }: { field: AirtableField; onOpenTable: (id: string) => void }) {
  const [full, setFull] = useState(false)
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <span className={cn('font-medium', f.junk ? 'text-amber-700' : 'text-gray-900')}>{f.name}</span>
        {f.primary && <span className="ml-1.5 rounded bg-gray-100 px-1 text-[10px] uppercase text-gray-500">primary</span>}
        {f.junk && <span className="ml-1.5 rounded bg-amber-50 px-1 text-[10px] uppercase text-amber-700">junk?</span>}
        {f.description && <p className="mt-0.5 text-xs text-gray-500">{f.description}</p>}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px]', f.computed ? 'bg-violet-50 text-violet-700' : 'bg-gray-100 text-gray-700')}>
          {typeLabel(f.type)}
        </span>
        {f.resultType && <span className="ml-1 text-[11px] text-gray-400">→ {typeLabel(f.resultType)}</span>}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600">
        {f.formula && (
          <div>
            <code className={cn('block whitespace-pre-wrap font-mono text-[11px] text-gray-800 [overflow-wrap:anywhere]', !full && 'line-clamp-2')}>{f.formula}</code>
            {f.formula.length > 140 && (
              <button type="button" className="text-gray-400 hover:text-gray-700" onClick={() => setFull((v) => !v)}>
                {full ? 'Show less' : 'Show full formula'}
              </button>
            )}
          </div>
        )}
        {f.linksTo && (
          <button type="button" className="text-blue-700 hover:underline" onClick={() => f.linkedTableId && onOpenTable(f.linkedTableId)}>
            → {f.linksTo}
          </button>
        )}
        {f.via && (
          <span>
            via <b>{f.via}</b>
            {f.source && <> → {f.source}</>}
          </span>
        )}
        {f.choices && f.choices.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {f.choices.map((c) => (
              <span key={c} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700">{c}</span>
            ))}
          </div>
        )}
        {f.label && <span>button «{f.label}»</span>}
      </td>
    </tr>
  )
}
