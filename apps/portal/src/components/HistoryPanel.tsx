import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, Card, StatusBadge } from './ui'
import { errMsg } from '../lib/utils'
import { HISTORY_PAGE, loadHistory } from '../services/audit'
import { actionWord, actorLabel, formatValue, recordLabel, shownFields, tableLabel, type AuditEntry } from '../domain/audit'

/**
 * История изменений приложения — кто, когда и что поменял (миграция 0019). Общая для
 * Receipts Matcher и GMB Agent: приложение различается `appUrl`.
 */
export function HistoryPanel({ appUrl }: { appUrl: string }) {
  const [peopleOnly, setPeopleOnly] = useState(false)
  const q = useInfiniteQuery({
    queryKey: ['portal-history', appUrl, peopleOnly],
    queryFn: ({ pageParam }) => loadHistory(appUrl, { peopleOnly, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === HISTORY_PAGE ? last[last.length - 1].id : undefined),
  })
  const entries = q.data?.pages.flat() ?? []

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Every change to this app’s data — by people and by automation — newest first.</p>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={peopleOnly} onChange={(e) => setPeopleOnly(e.target.checked)} />
          People only
        </label>
      </div>

      {q.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {q.error && <p className="text-sm text-red-600">{errMsg(q.error)}</p>}
      {!q.isLoading && !q.error && entries.length === 0 && <p className="text-sm text-gray-500">No changes recorded yet.</p>}

      <div className="space-y-2">
        {entries.map((e) => (
          <HistoryRow key={e.id} entry={e} />
        ))}
      </div>

      {q.hasNextPage && (
        <Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      )}
    </div>
  )
}

function HistoryRow({ entry: e }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const fields = shownFields(e)
  return (
    <Card className="p-4 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-gray-400">{new Date(e.changedAt).toLocaleString('en-US')}</span>
        <span className="font-medium text-gray-900">{actorLabel(e)}</span>
        {e.actorKind === 'automation' && <StatusBadge tone="neutral">automation</StatusBadge>}
        <span className="text-gray-600">
          {actionWord(e.action)} {tableLabel(e.tableName).toLowerCase()} <b className="text-gray-900">{recordLabel(e)}</b>
        </span>
        {fields.length > 0 && (
          <button type="button" className="ml-auto text-xs text-gray-500 hover:text-gray-800" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide details' : `Details (${fields.length})`}
          </button>
        )}
      </div>
      {open && (
        <dl className="mt-3 space-y-2 border-t border-gray-100 pt-3">
          {fields.map((f) => (
            <FieldChange key={f} field={f} before={e.oldData?.[f]} after={e.newData?.[f]} action={e.action} />
          ))}
        </dl>
      )}
    </Card>
  )
}

function FieldChange({ field, before, after, action }: { field: string; before: unknown; after: unknown; action: AuditEntry['action'] }) {
  const [full, setFull] = useState(false)
  const b = formatValue(before)
  const a = formatValue(after)
  const cut = b.cut || a.cut
  return (
    <div className="grid gap-1 sm:grid-cols-[160px_minmax(0,1fr)]">
      <dt className="font-mono text-xs text-gray-500">{field}</dt>
      <dd className="min-w-0 text-xs [overflow-wrap:anywhere]">
        {action !== 'insert' && <span className="whitespace-pre-wrap text-red-700 line-through decoration-red-300">{full ? b.full : b.short}</span>}
        {action === 'update' && <span className="mx-1 text-gray-400">→</span>}
        {action !== 'delete' && <span className="whitespace-pre-wrap text-green-700">{full ? a.full : a.short}</span>}
        {cut && (
          <button type="button" className="ml-2 text-gray-500 hover:text-gray-800" onClick={() => setFull((v) => !v)}>
            {full ? 'Show less' : 'Show full'}
          </button>
        )}
      </dd>
    </div>
  )
}
