import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, Plus, Trash2 } from 'lucide-react'
import { Button, Card, Input, StatusBadge } from '../../components/ui'
import { SaveBar } from '../../components/SaveBar'
import { errMsg } from '../../lib/utils'
import { loadNotify, saveNotify } from '../../services/receipt-notify'
import {
  MAX_RECIPIENTS, NOTIFY_KEYS,
  duplicateEmails, emptyRecipient, normalizeRecipients, sameRecipients, validateList,
  type NotifyKey, type Recipient, type RecipientErrors,
} from '../../domain/receipt-notify'

/**
 * Receipts Matcher · кому автоматизация пишет (BAS-1474).
 *
 * Три списка из `receipt_matcher_settings`. Сохраняются только изменённые, по одной строке
 * на ключ; сохранение действует со следующего прогона автоматизации (кэша нет).
 */
export function NotificationsTab() {
  const qc = useQueryClient()
  const [edits, setEdits] = useState<Partial<Record<NotifyKey, Recipient[]>>>({})

  const q = useQuery({ queryKey: ['receipt-notify'], queryFn: loadNotify })

  const baseline = useMemo(() => {
    const m = {} as Record<NotifyKey, Recipient[]>
    for (const s of q.data ?? []) m[s.key] = s.value
    return m
  }, [q.data])

  const listOf = (key: NotifyKey): Recipient[] => edits[key] ?? baseline[key] ?? []
  const setList = (key: NotifyKey, list: Recipient[]) => setEdits((e) => ({ ...e, [key]: list }))

  const changed = useMemo(
    () =>
      NOTIFY_KEYS.filter(({ key }) => edits[key] && !sameRecipients(edits[key]!, baseline[key] ?? [])).map(({ key }) => ({
        key,
        value: normalizeRecipients(edits[key]!),
      })),
    [edits, baseline],
  )
  const blocking = changed.filter((c) => !validateList(edits[c.key]!).ok).length

  const saveM = useMutation({
    mutationFn: () => saveNotify(changed),
    onSuccess: async () => {
      setEdits({})
      await qc.invalidateQueries({ queryKey: ['receipt-notify'] })
    },
  })

  if (q.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (q.error) return <p className="text-sm text-red-600">{errMsg(q.error)}</p>

  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-sm text-gray-500">
        Who the receipts automation writes to. A save takes effect on its next run.
      </p>

      {NOTIFY_KEYS.map((meta) => {
        const setting = q.data?.find((s) => s.key === meta.key)
        return (
          <RecipientList
            key={meta.key}
            label={meta.label}
            hint={meta.hint}
            emptyNote={meta.emptyNote}
            updatedAt={setting?.updatedAt ?? null}
            list={listOf(meta.key)}
            dirty={changed.some((c) => c.key === meta.key)}
            onChange={(l) => setList(meta.key, l)}
          />
        )
      })}

      <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
        <Info size={15} className="mt-0.5 shrink-0" />
        <span>An empty list means nobody is told.</span>
      </div>

      <SaveBar
        count={changed.length}
        blocking={blocking}
        saving={saveM.isPending}
        saved={saveM.isSuccess && changed.length === 0}
        error={saveM.error ? errMsg(saveM.error) : null}
        onSave={() => saveM.mutate()}
        onDiscard={() => setEdits({})}
      />
    </div>
  )
}

function RecipientList({
  label, hint, emptyNote, updatedAt, list, dirty, onChange,
}: {
  label: string
  hint: string
  emptyNote?: string
  updatedAt: string | null
  list: Recipient[]
  dirty: boolean
  onChange: (l: Recipient[]) => void
}) {
  const check = validateList(list)
  const dups = duplicateEmails(list)

  const patch = (i: number, p: Partial<Recipient>) => onChange(list.map((r, j) => (j === i ? { ...r, ...p } : r)))

  return (
    <Card className="p-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium text-gray-900">{label}</span>
        {dirty && <StatusBadge tone="warning">unsaved</StatusBadge>}
        {updatedAt && (
          <span className="ml-auto text-xs text-gray-400">Last changed {new Date(updatedAt).toLocaleString('en-US')}</span>
        )}
      </div>
      <p className="mb-4 text-sm text-gray-500">{hint}</p>

      {list.length === 0 ? (
        <div className="mb-3 rounded-lg border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-600">
          Nobody is told.
          {emptyNote && <p className="mt-1 text-xs text-amber-700">{emptyNote}</p>}
        </div>
      ) : (
        <div className="mb-3 space-y-3">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_36px] gap-2 text-xs text-gray-400 sm:grid">
            <span>Name</span><span>Email</span><span>Phone (optional)</span><span />
          </div>
          {list.map((r, i) => (
            <RecipientRow
              key={i}
              value={r}
              errors={check.rows[i]}
              duplicate={dups.has(r.email.trim().toLowerCase())}
              onChange={(p) => patch(i, p)}
              onRemove={() => onChange(list.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      {check.list && <p className="mb-2 text-sm text-red-600">{check.list}</p>}
      {list.length < MAX_RECIPIENTS && (
        <Button variant="ghost" className="px-2" onClick={() => onChange([...list, emptyRecipient()])}>
          <Plus size={15} /> Add person
        </Button>
      )}
    </Card>
  )
}

function RecipientRow({
  value, errors, duplicate, onChange, onRemove,
}: {
  value: Recipient
  errors: RecipientErrors
  duplicate: boolean
  onChange: (p: Partial<Recipient>) => void
  onRemove: () => void
}) {
  // Только что добавленная пустая строка — одна понятная фраза вместо трёх красных ошибок.
  const blank = !value.name.trim() && !value.email.trim() && !value.phone.trim()
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_36px] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_36px]">
        <div className="max-sm:col-span-1">
          <Input value={value.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name" aria-label="Name" />
          {!blank && errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
        </div>
        <div className="max-sm:order-3 max-sm:col-span-2">
          <Input type="email" value={value.email} onChange={(e) => onChange({ email: e.target.value })} placeholder="name@basementremodeling.com" aria-label="Email" />
          {!blank && errors.email && <p className="mt-1 text-xs text-red-600">{errors.email}</p>}
          {!errors.email && duplicate && <p className="mt-1 text-xs text-amber-700">This address is already in the list.</p>}
        </div>
        <div className="max-sm:order-4 max-sm:col-span-2">
          <Input value={value.phone} onChange={(e) => onChange({ phone: e.target.value })} placeholder="+13015550123" aria-label="Phone" />
          {!blank && errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
        </div>
        <Button variant="ghost" aria-label="Remove person" className="h-9 px-2 text-gray-400 hover:text-red-600 max-sm:order-2" onClick={onRemove}>
          <Trash2 size={15} />
        </Button>
      </div>
      {blank && <p className="mt-1 text-xs text-red-600">Fill in this person or remove the row.</p>}
    </div>
  )
}
