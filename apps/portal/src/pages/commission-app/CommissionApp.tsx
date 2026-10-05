import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Inbox } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Cell, DataTable, PageTitle, StatusBadge, Tabs, type Column } from '../../components/ui'
import { useAuth } from '../../auth/AuthProvider'
import { errMsg } from '../../lib/utils'
import {
  formatMoney,
  isConfirmable,
  parseRecordIds,
  skipReason,
  summarize,
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
      {tab === 'confirm' && <ConfirmTab parsed={parsed} />}
      {tab === 'history' && <HistoryTab />}
    </div>
  )
}

function ConfirmTab({ parsed }: { parsed: ReturnType<typeof parseRecordIds> }) {
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
        <Button variant="primary" className="px-6 py-2.5" disabled={s.confirmable.length === 0 || m.isPending} onClick={() => m.mutate()}>
          <CheckCircle2 size={16} />
          {m.isPending ? 'Confirming…' : 'Confirm payment'}
        </Button>
      </Card>

      {s.confirmable.length === 0 && records.length > 0 && (
        <p className="text-center text-sm text-gray-500">Nothing to confirm: every Change Order here is already paid or not requested.</p>
      )}

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
  const q = useQuery({ queryKey: ['cp-confirmations'], queryFn: () => listConfirmations(100) })

  if (q.isLoading) return <Card className="px-6 py-12 text-center text-sm text-gray-400">Loading…</Card>
  if (q.error) return <Card className="px-6 py-12 text-center text-sm text-red-600">{errMsg(q.error)}</Card>

  const rows = q.data ?? []
  if (rows.length === 0) {
    return <Card className="px-6 py-12 text-center text-sm text-gray-400">No payouts confirmed yet.</Card>
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <HistoryRow key={r.id} row={r} />
      ))}
    </div>
  )
}

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
      <button className="flex w-full flex-wrap items-start justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)}>
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
