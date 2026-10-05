import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Inbox, Search, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Cell, DataTable, Input, PageTitle, Select, StatusBadge, Tabs, type Column } from '../../components/ui'
import { DatePicker } from '../sales/DatePicker'
import { useAuth } from '../../auth/AuthProvider'
import { errMsg } from '../../lib/utils'
import {
  EMPTY_HISTORY_FILTER,
  endExclusive,
  filterHistory,
  formatMoney,
  historyPeople,
  isConfirmable,
  parseRecordIds,
  skipReason,
  startOfDay,
  summarize,
  type HistoryFilter,
  type PayoutRecord,
} from '../../domain/commission-app'
import {
  confirmPayout,
  listConfirmations,
  loadPayoutRecords,
  type ConfirmResult,
  type PayoutConfirmation,
  type PayoutHistoryEntry,
} from '../../services/commission-app'

/**
 * Commission App (BAS-1635). Billing открывает ссылку из письма «Commission Payout Request»
 * (`/commission-app?ids=rec…,rec…`), видит Change Order'ы запроса и подтверждает оплату.
 * PAID ставится только записям в REQUESTED; каждое подтверждение — строка в истории с
 * аккаунтом, под которым вошли, датой и списком записей.
 */
export function CommissionAppPage() {
  const [params] = useSearchParams()
  const parsed = useMemo(() => parseRecordIds(params.get('ids')), [params])
  const [tab, setTab] = useState<'confirm' | 'history'>(parsed.ids.length ? 'confirm' : 'history')

  return (
    <div className="mx-auto max-w-5xl">
      <PageTitle
        title="Commission App"
        subtitle="Confirm commission payouts for Change Orders. Every confirmation is saved with the account that confirmed it."
      />
      <Tabs<'confirm' | 'history'>
        className="mb-6 max-w-sm"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'confirm', label: 'Confirm payout' },
          { key: 'history', label: 'History' },
        ]}
      />
      {tab === 'confirm' && <ConfirmTab parsed={parsed} onOpenHistory={() => setTab('history')} />}
      {tab === 'history' && <HistoryTab />}
    </div>
  )
}

function ConfirmTab({ parsed, onOpenHistory }: { parsed: ReturnType<typeof parseRecordIds>; onOpenHistory: () => void }) {
  const { authUser } = useAuth()
  const qc = useQueryClient()
  const ids = parsed.ids

  const q = useQuery({
    queryKey: ['commission-payout', ids],
    queryFn: () => loadPayoutRecords(ids),
    enabled: ids.length > 0,
  })

  const [result, setResult] = useState<ConfirmResult | null>(null)
  const m = useMutation({
    mutationFn: () => confirmPayout(ids),
    onSuccess: (r) => {
      setResult(r)
      qc.invalidateQueries({ queryKey: ['commission-payout'] })
      qc.invalidateQueries({ queryKey: ['cp-confirmations'] })
    },
    // ошибка остаётся в m.error и показывается под кнопкой; историю тоже перечитываем —
    // неудачная попытка в неё записана
    onError: () => qc.invalidateQueries({ queryKey: ['cp-confirmations'] }),
  })

  if (ids.length === 0) {
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <Inbox className="mb-3 text-gray-300" size={36} />
        <div className="font-semibold text-gray-900">No payout request opened</div>
        <p className="mt-1 max-w-md text-sm text-gray-500">
          Open this page from the “Mark All as Paid” button in a Commission Payout Request email.
        </p>
        {parsed.invalid.length > 0 && (
          <p className="mt-3 text-xs text-red-600">The link looks damaged: it has no valid Change Order ids.</p>
        )}
      </Card>
    )
  }

  if (result) return <ThankYou result={result} />

  if (q.isLoading) return <Card className="px-6 py-12 text-center text-sm text-gray-400">Loading Change Orders…</Card>
  if (q.error) return <Card className="px-6 py-12 text-center text-sm text-red-600">{errMsg(q.error)}</Card>

  const records = q.data ?? []
  const s = summarize(records)
  const missing = ids.filter((id) => !records.some((r) => r.id === id))

  // Подтверждать нечего (запрос уже обработан или записи не в REQUESTED) — таблица и итог
  // тут лишние: кто и когда подтвердил, видно в History.
  if (s.confirmable.length === 0) {
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <CheckCircle2 className="mb-3 text-gray-300" size={40} />
        <div className="font-semibold text-gray-900">Nothing to confirm</div>
        <p className="mt-1 max-w-md text-sm text-gray-500">
          This payout request has already been processed, or its Change Orders are not in REQUESTED status.
        </p>
        <Button className="mt-5" onClick={onOpenHistory}>
          Open History
        </Button>
      </Card>
    )
  }

  const columns: Column<PayoutRecord>[] = [
    { key: 'co', header: 'Change Order', render: (r) => <Cell title={r.billingRecordId} sub={r.projectName ?? undefined} /> },
    { key: 'req', header: 'Requester', render: (r) => <Cell title={r.requester ?? '—'} sub={r.pm ? `PM: ${r.pm}` : undefined} /> },
    { key: 'total', header: 'CO total', align: 'right', render: (r) => formatMoney(r.coTotal) },
    { key: 'comm', header: 'Commission', align: 'right', render: (r) => <span className="font-semibold">{formatMoney(r.commission)}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        isConfirmable(r) ? (
          <StatusBadge tone="pending">Requested</StatusBadge>
        ) : (
          <div>
            <StatusBadge tone={r.status === 'PAID' ? 'success' : 'neutral'}>{r.status ?? 'No status'}</StatusBadge>
            <div className="mt-1 text-xs text-gray-400">{skipReason(r)} — will be skipped</div>
          </div>
        ),
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <DataTable columns={columns} rows={records} getRowKey={(r) => r.id} empty="None of these Change Orders were found in Airtable." />
      </Card>

      {(missing.length > 0 || parsed.invalid.length > 0 || parsed.tooMany) && (
        <Card className="flex gap-3 border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            {missing.length > 0 && <div>{missing.length} Change Order(s) from the link were not found in Airtable.</div>}
            {parsed.invalid.length > 0 && <div>The link contains {parsed.invalid.length} invalid id(s); they were ignored.</div>}
            {parsed.tooMany && <div>The link has too many Change Orders; only the first {ids.length} are shown.</div>}
          </div>
        </Card>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="text-sm text-gray-500">
            To be marked as paid: <span className="font-semibold text-gray-900">{s.confirmable.length}</span> Change Order(s)
          </div>
          <div className="mt-0.5 text-2xl font-bold text-gray-900">{formatMoney(s.total)}</div>
          <div className="mt-1 text-xs text-gray-500">
            Confirming as <span className="font-medium text-gray-700">{authUser?.email ?? '—'}</span>
          </div>
        </div>
        <Button variant="primary" className="px-6 py-2.5" disabled={m.isPending} onClick={() => m.mutate()}>
          <CheckCircle2 size={16} />
          {m.isPending ? 'Confirming…' : 'Confirm payment'}
        </Button>
      </Card>

      {m.error && (
        <Card className="flex gap-3 border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Payment was not confirmed</div>
            <div className="mt-0.5">{errMsg(m.error)}</div>
          </div>
        </Card>
      )}
    </div>
  )
}

function ThankYou({ result }: { result: ConfirmResult }) {
  const c = result.confirmation
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <CheckCircle2 className="mb-3 text-green-500" size={44} />
      <h2 className="text-2xl font-bold text-gray-900">Thank you!</h2>
      <p className="mt-2 text-sm text-gray-600">
        {result.paidCount} Change Order(s) marked as <b>PAID</b> — {formatMoney(result.totalPaid)}.
      </p>
      {c && (
        <p className="mt-1 text-xs text-gray-500">
          Confirmed by {c.confirmed_by_email} on {new Date(c.confirmed_at).toLocaleString('en-US')}
        </p>
      )}
      {result.skipped.length > 0 && (
        <p className="mt-3 text-xs text-gray-500">{result.skipped.length} Change Order(s) were skipped (already paid or not requested).</p>
      )}
      {result.historyError && (
        <p className="mt-3 max-w-md text-xs text-amber-700">
          The payment is marked in Airtable, but this confirmation was not saved to History: {result.historyError}
        </p>
      )}
    </Card>
  )
}

function HistoryTab() {
  const [f, setF] = useState<HistoryFilter>(EMPTY_HISTORY_FILTER)
  const set = (patch: Partial<HistoryFilter>) => setF((prev) => ({ ...prev, ...patch }))

  // Даты — в запрос (на сервере), люди и поиск — по загруженному.
  const from = f.from ? startOfDay(f.from) : null
  const toExclusive = f.to ? endExclusive(f.to) : null
  const q = useQuery({
    queryKey: ['cp-confirmations', from?.toISOString() ?? null, toExclusive?.toISOString() ?? null],
    queryFn: () => listConfirmations({ from, toExclusive }, HISTORY_LIMIT),
  })

  const all = q.data ?? []
  const people = useMemo(() => historyPeople(all), [all])
  const rows = useMemo(() => filterHistory(all, f), [all, f])
  const total = rows.reduce((sum, r) => sum + Number(r.total_paid), 0)
  const hasFilter = !!(f.from || f.to || f.requester || f.confirmedBy || f.search.trim())

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">From</span>
            <DatePicker value={f.from} onChange={(d) => set({ from: d })} placeholder="Any date" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">To</span>
            <DatePicker value={f.to} onChange={(d) => set({ to: d })} placeholder="Any date" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">Requester</span>
            <Select value={f.requester} onChange={(e) => set({ requester: e.target.value })} className="w-48">
              <option value="">Everyone</option>
              {people.requesters.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">Confirmed by</span>
            <Select value={f.confirmedBy} onChange={(e) => set({ confirmedBy: e.target.value })} className="w-56">
              <option value="">Anyone</option>
              {people.confirmers.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </label>
          <label className="block min-w-[14rem] flex-1">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">Search</span>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={f.search}
                onChange={(e) => set({ search: e.target.value })}
                placeholder="CO number, project, record id"
                className="pl-9"
              />
            </div>
          </label>
          {hasFilter && (
            <Button variant="ghost" onClick={() => setF(EMPTY_HISTORY_FILTER)}>
              <X size={15} /> Clear
            </Button>
          )}
        </div>
      </Card>

      {q.isLoading ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">Loading…</Card>
      ) : q.error ? (
        <Card className="px-6 py-12 text-center text-sm text-red-600">{errMsg(q.error)}</Card>
      ) : rows.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-gray-400">
          {hasFilter ? 'No confirmations match these filters.' : 'No payouts confirmed yet.'}
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-gray-500">
            <span>
              {rows.length} confirmation(s) · <span className="font-semibold text-gray-900">{formatMoney(total)}</span> paid
            </span>
            {all.length >= HISTORY_LIMIT && (
              <span className="text-xs text-amber-700">Showing the latest {HISTORY_LIMIT}. Narrow the dates to see older ones.</span>
            )}
          </div>
          <div className="space-y-3">
            {rows.map((r) => (
              <HistoryRow key={r.id} row={r} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const HISTORY_LIMIT = 500

const STATUS_LABEL: Record<PayoutConfirmation['status'], { tone: 'success' | 'warning' | 'danger'; label: string }> = {
  confirmed: { tone: 'success', label: 'Confirmed' },
  partial: { tone: 'warning', label: 'Partially confirmed' },
  failed: { tone: 'danger', label: 'Failed' },
}

function HistoryRow({ row }: { row: PayoutConfirmation }) {
  const [open, setOpen] = useState(false)
  const st = STATUS_LABEL[row.status]
  return (
    <Card className="p-4">
      <button className="flex w-full flex-wrap items-start justify-between gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => setOpen((v) => !v)}>
        <div className="flex min-w-0 flex-1 gap-2">
          {open ? <ChevronDown size={18} className="mt-0.5 text-gray-400" /> : <ChevronRight size={18} className="mt-0.5 text-gray-400" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-gray-900">{row.requester_names.join(', ') || 'Unknown requester'}</span>
              <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {new Date(row.confirmed_at).toLocaleString('en-US')} · by {row.confirmed_by_email}
            </div>
            {row.error && <div className="mt-1 text-xs text-red-600">{row.error}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold text-gray-900">{formatMoney(Number(row.total_paid))}</div>
          <div className="text-xs text-gray-500">{row.paid_count} paid</div>
        </div>
      </button>
      {open && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <table className="w-full text-sm">
            <tbody>
              {row.records.map((e: PayoutHistoryEntry) => (
                <tr key={e.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-gray-800">{e.billingRecordId ?? e.id}</div>
                    {e.projectName && <div className="text-xs text-gray-500">{e.projectName}</div>}
                    <a
                      href={`https://airtable.com/${row.airtable_base}/${row.airtable_table}/${e.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-blue-600 hover:underline"
                      title="Open the record in Airtable"
                    >
                      {e.id}
                    </a>
                  </td>
                  <td className="py-2 pr-3 text-gray-600">{e.requester ?? '—'}</td>
                  <td className="py-2 pr-3 text-right">{formatMoney(e.commission ?? null)}</td>
                  <td className="py-2 text-right">
                    <StatusBadge tone={e.result === 'paid' ? 'success' : e.result === 'failed' ? 'danger' : 'neutral'}>
                      {e.result}
                    </StatusBadge>
                    {e.reason && <div className="mt-0.5 text-xs text-gray-400">{e.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
