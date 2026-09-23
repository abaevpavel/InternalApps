import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileText, Lock, X } from 'lucide-react'
import { Button, Card, Dropdown, Field, PageTitle, StatusBadge } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { loadAccounts, loadRuns, submitImport } from '../../services/receipt-import'
import {
  POLL_MS, STATUS_PILL, TWPERRY_LABEL,
  accountLabel, activeRun, emptyForm, formatSize, resultLine, submitLabel, toggleTwPerry, validateForm,
  type ImportAccount, type ImportField, type ImportForm, type ImportRun,
} from '../../domain/receipt-import'

/**
 * 07 Finances — Receipts Matcher · импорт транзакций (BAS-1450).
 *
 * Одна форма вместо двух отдельных с общим паролем: человек выбирает счёт, кладёт выгрузку
 * (для месяца TW Perry — ещё и PDF выписки), выбирает Dry run или Live. Импорт идёт в фоне,
 * результат появляется в истории на этом же экране. Контракт — вложение к BAS-1450.
 */
export function ReceiptImportPage() {
  const qc = useQueryClient()
  const [form, setForm] = useState<ImportForm>(emptyForm)
  const [attempted, setAttempted] = useState(false)
  // Ответ сервера: фраза под конкретным полем или общая над кнопкой.
  const [serverField, setServerField] = useState<Partial<Record<ImportField, string>>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pointAt, setPointAt] = useState<string | null>(null)

  const accountsQ = useQuery({ queryKey: ['receipt-import-accounts'], queryFn: loadAccounts })
  const runsQ = useQuery({
    queryKey: ['receipt-import-runs'],
    queryFn: loadRuns,
    // Realtime в портале нет и здесь не нужен: пока что-то в работе — перечитываем раз в 5 с.
    refetchInterval: (query) => (activeRun(query.state.data ?? []) ? POLL_MS : false),
  })

  const runs = runsQ.data ?? []
  const accounts = accountsQ.data ?? []
  const running = activeRun(runs)
  const localErrors = useMemo(() => validateForm(form), [form])

  const submitM = useMutation({
    mutationFn: () => submitImport(form),
    onSuccess: async (res) => {
      if (res.ok) {
        setAttempted(false)
        // Live между визитами не запоминаем — и после отправки тоже возвращаемся к Dry run.
        setForm((f) => ({ ...f, mode: 'dry' }))
        if (res.runId) setExpanded(null)
      } else {
        if (res.field) setServerField({ [res.field]: res.message })
        else setServerError(res.message)
        if (res.runId) {
          setExpanded(res.runId)
          setPointAt(res.runId)
        }
      }
      await qc.invalidateQueries({ queryKey: ['receipt-import-runs'] })
    },
    onError: (e) => setServerError(errMsg(e)),
  })

  function update(patch: Partial<ImportForm>, field?: ImportField) {
    setForm((f) => ({ ...f, ...patch }))
    setServerError(null)
    if (field) setServerField((s) => ({ ...s, [field]: undefined }))
  }

  function onSubmit() {
    setAttempted(true)
    setServerError(null)
    setServerField({})
    if (Object.keys(localErrors).length) return
    submitM.mutate()
  }

  /** Ошибка поля: серверная — всегда; локальная — после попытки отправки или сразу для выбранного файла. */
  function fieldError(f: ImportField): string | undefined {
    if (serverField[f]) return serverField[f]
    const local = localErrors[f]
    if (!local) return undefined
    const fileChosen = (f === 'csv' && form.csv) || (f === 'pdf' && form.pdf)
    return attempted || fileChosen ? local : undefined
  }

  const locked = !!running || submitM.isPending

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-10 pb-24 sm:px-6">
      <PageTitle title="Import transactions" subtitle="One export into TRANSACTIONS. Matching, employees and projects are filled afterwards." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        <Card className="h-fit space-y-5 p-6">
          <TwPerryToggle checked={form.twperryMonth} onChange={(on) => { setForm((f) => toggleTwPerry(f, on)); setServerField({}); setServerError(null) }} />

          {form.twperryMonth ? (
            <Field label="Account">
              <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-700">
                <Lock size={14} className="text-gray-400" /> {TWPERRY_LABEL}
              </div>
            </Field>
          ) : (
            <Field label="Account" required>
              {accountsQ.error ? (
                <p className="text-sm text-red-600">{errMsg(accountsQ.error)}</p>
              ) : (
                <Dropdown
                  value={form.account}
                  onChange={(v) => update({ account: v }, 'account')}
                  options={accounts.map((a) => ({ value: a.account, label: a.label }))}
                  placeholder={accountsQ.isLoading ? 'Loading…' : 'Choose an account'}
                  disabled={accountsQ.isLoading}
                />
              )}
              <FieldError text={fieldError('account')} />
            </Field>
          )}

          <Field label="CSV file" required>
            <FilePicker accept=".csv,text/csv" file={form.csv} onChange={(f) => update({ csv: f }, 'csv')} placeholder="Choose the .csv export" />
            <FieldError text={fieldError('csv')} />
          </Field>

          {form.twperryMonth && (
            <Field label="Statement PDF" required>
              <FilePicker accept=".pdf,application/pdf" file={form.pdf} onChange={(f) => update({ pdf: f }, 'pdf')} placeholder="Choose the statement .pdf" />
              <FieldError text={fieldError('pdf')} />
            </Field>
          )}

          <Field label="Mode">
            <div className="flex rounded-lg border border-gray-200 p-0.5">
              {(['dry', 'live'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => update({ mode: m }, 'mode')}
                  className={cn(
                    'flex-1 rounded-md py-2 text-sm font-medium transition',
                    form.mode === m ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {m === 'dry' ? 'Dry run' : 'Live'}
                </button>
              ))}
            </div>
            {form.mode === 'dry' ? (
              <p className="mt-1.5 text-xs text-gray-500">Shows what would happen. Writes nothing.</p>
            ) : (
              <p className="mt-1.5 text-xs font-medium text-amber-700">Writes to the bookkeeping table. Can’t be undone from this screen.</p>
            )}
            <FieldError text={fieldError('mode')} />
          </Field>

          {serverError && <p className="text-sm text-red-600">{serverError}</p>}

          <Button variant={form.mode === 'live' ? 'primary' : 'outline'} disabled={locked} onClick={onSubmit}>
            {submitM.isPending ? 'Sending…' : submitLabel(form)}
          </Button>
        </Card>

        <History
          runs={runs}
          accounts={accounts}
          loading={runsQ.isLoading}
          error={runsQ.error ? errMsg(runsQ.error) : null}
          running={running}
          expanded={expanded}
          onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
          pointAt={pointAt}
          onPointed={() => setPointAt(null)}
        />
      </div>
    </div>
  )
}

/* ---------------- форма ---------------- */

function FieldError({ text }: { text?: string }) {
  return text ? <p className="mt-1 text-sm text-red-600">{text}</p> : null
}

function TwPerryToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 p-4">
      <div>
        <p className="text-sm font-medium text-gray-900">TW Perry monthly statement</p>
        <p className="text-xs text-gray-500">The CSV and the statement PDF from the same Billtrust mail.</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="TW Perry monthly statement"
        onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-blue-600' : 'bg-gray-300')}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  )
}

/** Один файл на поле. Повторный выбор заменяет файл; крестик — убирает. */
function FilePicker({
  accept, file, onChange, placeholder,
}: { accept: string; file: File | null; onChange: (f: File | null) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
      <FileText size={15} className="shrink-0 text-gray-400" />
      <button type="button" onClick={() => ref.current?.click()} className="min-w-0 flex-1 truncate text-left">
        {file ? (
          <span className="text-gray-900">{file.name} · {formatSize(file.size)}</span>
        ) : (
          <span className="text-gray-400">{placeholder}</span>
        )}
      </button>
      {file && (
        <button type="button" aria-label="Remove file" onClick={() => onChange(null)} className="rounded p-0.5 text-gray-400 hover:text-gray-700">
          <X size={14} />
        </button>
      )}
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onChange(e.target.files?.[0] ?? null)
          // Сбрасываем, чтобы повторный выбор того же файла тоже срабатывал.
          e.target.value = ''
        }}
      />
    </div>
  )
}

/* ---------------- история ---------------- */

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function History({
  runs, accounts, loading, error, running, expanded, onToggle, pointAt, onPointed,
}: {
  runs: ImportRun[]
  accounts: ImportAccount[]
  loading: boolean
  error: string | null
  running: ImportRun | null
  expanded: string | null
  onToggle: (id: string) => void
  pointAt: string | null
  onPointed: () => void
}) {
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // 409: «другой импорт ещё идёт» — прокручиваем к нему.
  useEffect(() => {
    if (!pointAt) return
    rowRefs.current[pointAt]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    onPointed()
  }, [pointAt, runs, onPointed])

  return (
    <Card className="h-fit p-6">
      <h2 className="mb-4 text-base font-semibold text-gray-900">Recent imports</h2>

      {running && (
        <div className="mb-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
          An import is running, started by {running.createdByName ?? 'someone'} at {clock(running.createdAt)}. The form unlocks when it finishes.
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && runs.length === 0 && <p className="text-sm text-gray-500">No imports yet.</p>}

      {runs.length > 0 && (
        <div className="divide-y divide-gray-100">
          <div className="hidden grid-cols-[120px_120px_minmax(0,1fr)_96px_16px] gap-3 pb-2 text-xs text-gray-400 sm:grid">
            <span>When</span><span>Account</span><span>Result</span><span>Status</span><span />
          </div>
          {runs.map((r) => {
            const pill = STATUS_PILL[r.status] ?? { label: r.status, tone: 'neutral' as const }
            const open = expanded === r.id
            return (
              <div key={r.id} ref={(el) => { rowRefs.current[r.id] = el }}>
                <button
                  type="button"
                  onClick={() => onToggle(r.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3 text-left text-sm sm:grid-cols-[120px_120px_minmax(0,1fr)_96px_16px] sm:items-center"
                >
                  <span>
                    <span className="block text-gray-900">{when(r.createdAt)}</span>
                    <span className="block text-xs text-gray-500">{r.createdByName ?? '—'}</span>
                  </span>
                  <span className="text-gray-700 max-sm:order-3">{accountLabel(r, accounts)}</span>
                  <span className="text-gray-600 max-sm:order-4 max-sm:col-span-2">{resultLine(r)}</span>
                  <span className="max-sm:order-2 max-sm:justify-self-end"><StatusBadge tone={pill.tone}>{pill.label}</StatusBadge></span>
                  <ChevronDown size={14} className={cn('hidden text-gray-400 transition sm:block', open && 'rotate-180')} />
                </button>
                {open && <RunDetails run={r} />}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function RunDetails({ run }: { run: ImportRun }) {
  const files = [run.csvName, run.pdfName].filter(Boolean).join(', ')
  const rows: { label: string; value: string }[] = [
    ...(files ? [{ label: 'Files', value: files }] : []),
    ...run.details,
    ...(run.startedAt ? [{ label: 'Started', value: when(run.startedAt) }] : []),
    ...(run.finishedAt ? [{ label: 'Finished', value: when(run.finishedAt) }] : []),
  ]
  return (
    <div className="mb-3 rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm">
      {rows.length > 0 && (
        <dl className="space-y-1">
          {rows.map((d, i) => (
            <div key={i} className="flex justify-between gap-4">
              <dt className="text-gray-600">{d.label}</dt>
              <dd className="text-right text-gray-900 [overflow-wrap:anywhere]">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {run.problems.length > 0 && (
        <div className={cn('text-amber-800', rows.length > 0 && 'mt-3')}>
          <p className="font-medium">Needs a look:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {run.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}
      {rows.length === 0 && run.problems.length === 0 && <p className="text-gray-500">No details yet.</p>}
    </div>
  )
}
