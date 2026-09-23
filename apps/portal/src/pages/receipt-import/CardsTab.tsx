import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Card, Input, Modal, StatusBadge, Textarea } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { DuplicateNumberError, addCard, deleteCard, loadCardsData, syncEmployeesNow, updateCard } from '../../services/receipt-cards'
import {
  ISSUERS, cardsOf, displayName, holderOf, lastSync, maskLast4, removesLastCard, validateIssuer, validateLast4, validateReason,
  type CardNumber, type Employee,
} from '../../domain/receipt-cards'

/**
 * Receipts Matcher · сотрудники и номера карт (BAS-1472).
 *
 * Люди приходят из Airtable «All employees» синком (раз в сутки + «Sync now») — завести человека
 * здесь нельзя по решению задачи: сотрудник, которого нет в Airtable, не может попасть на чек.
 * Карты живут только здесь — это единственная копия списка, и сохранение сразу действует.
 */
export function CardsTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['receipt-cards'], queryFn: loadCardsData })
  const [search, setSearch] = useState('')
  const [showLeft, setShowLeft] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; body: string; cta: string; run: () => Promise<void> } | null>(null)

  const employees = q.data?.employees ?? []
  const cards = q.data?.cards ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: ['receipt-cards'] })

  /**
   * Любая запись в карты. Дубль ловим ДО базы (понятная фраза, кто держит номер), а если
   * кто-то успел раньше — переводим отказ unique-индекса в ту же фразу.
   */
  async function write(fn: () => Promise<void>, dupCheck?: { last4: string; exceptId?: string }): Promise<string | null> {
    if (dupCheck) {
      const held = holderOf(dupCheck.last4, cards, employees, dupCheck.exceptId)
      if (held) return held
    }
    try {
      await fn()
      await refresh()
      return null
    } catch (e) {
      if (e instanceof DuplicateNumberError && dupCheck) {
        await refresh()
        return `${dupCheck.last4} is already in use — the list has just been reloaded, see who holds it.`
      }
      return errMsg(e)
    }
  }

  /** Снять карту с активных — с подтверждением, если это последняя карта во всей таблице. */
  function guardLast(card: CardNumber, title: string, run: () => Promise<void>) {
    if (!removesLastCard(card, cards)) return run()
    setConfirm({
      title,
      body:
        'This is the last active card in the whole list. The receipts automation refuses to run on an empty card list, so no receipt will be matched to anybody until a card is added again.',
      cta: 'Remove the last card',
      run,
    })
    return Promise.resolve()
  }

  const syncM = useMutation({ mutationFn: syncEmployeesNow, onSuccess: refresh })

  const needle = search.trim().toLowerCase()
  const active = useMemo(
    () => employees.filter((e) => e.active && (!needle || displayName(e.fullName).toLowerCase().includes(needle) || cards.some((c) => c.employeeId === e.id && c.last4.includes(needle)))),
    [employees, cards, needle],
  )
  const left = employees.filter((e) => !e.active)
  const shared = cards.filter((c) => c.kind === 'shared_card').sort((a, b) => Number(b.active) - Number(a.active) || a.last4.localeCompare(b.last4))
  const notCards = cards.filter((c) => c.kind === 'not_a_card').sort((a, b) => Number(b.active) - Number(a.active) || a.last4.localeCompare(b.last4))

  if (q.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (q.error) return <p className="text-sm text-red-600">{errMsg(q.error)}</p>

  const synced = lastSync(employees)

  return (
    <div className="max-w-4xl space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 text-sm text-gray-600">
            <p>
              People come from Airtable <span className="font-medium">All employees</span> once a day. To add someone, add them in
              Airtable — they appear here after the next sync. Someone removed there stays here as <em>left</em>, with their cards kept.
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {synced ? `Last synced ${new Date(synced).toLocaleString('en-US')}` : 'Not synced yet.'}
            </p>
          </div>
          <Button onClick={() => syncM.mutate()} disabled={syncM.isPending}>
            <RefreshCw size={15} className={cn(syncM.isPending && 'animate-spin')} /> {syncM.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {syncM.data && (
          <p className="mt-3 text-sm text-green-700">
            Synced {syncM.data.fetched} people from Airtable: {syncM.data.added} added, {syncM.data.updated} updated,{' '}
            {syncM.data.reactivated} back, {syncM.data.deactivated} left.
          </p>
        )}
        {syncM.error && <p className="mt-3 text-sm text-red-600">{errMsg(syncM.error)}</p>}
      </Card>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">Employees and their cards</h2>
          <Input className="max-w-xs" placeholder="Search by name or last four digits" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="space-y-3">
          {active.map((e) => (
            <EmployeeBlock key={e.id} employee={e} cards={cardsOf(e.id, cards)} write={write} guardLast={guardLast} ask={setConfirm} />
          ))}
          {active.length === 0 && <p className="text-sm text-gray-500">Nobody matches.</p>}
        </div>

        {left.length > 0 && (
          <div className="mt-4">
            <button type="button" className="text-sm text-gray-500 hover:text-gray-800" onClick={() => setShowLeft((v) => !v)}>
              {showLeft ? 'Hide' : 'Show'} people no longer in Airtable ({left.length})
            </button>
            {showLeft && (
              <div className="mt-3 space-y-3 opacity-80">
                {left.map((e) => (
                  <EmployeeBlock key={e.id} employee={e} cards={cardsOf(e.id, cards)} write={write} guardLast={guardLast} ask={setConfirm} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <SharedCardSection cards={shared} write={write} guardLast={guardLast} ask={setConfirm} />

      <NotACardSection cards={notCards} write={write} ask={setConfirm} />

      <Modal
        open={!!confirm}
        title={confirm?.title ?? ''}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const c = confirm
                setConfirm(null)
                await c?.run()
              }}
            >
              {confirm?.cta}
            </Button>
          </>
        }
      >
        {confirm?.body}
      </Modal>
    </div>
  )
}

type Write = (fn: () => Promise<void>, dupCheck?: { last4: string; exceptId?: string }) => Promise<string | null>
type Ask = (c: { title: string; body: string; cta: string; run: () => Promise<void> }) => void

/* ---------------- сотрудник ---------------- */

function EmployeeBlock({
  employee: e, cards, write, guardLast, ask,
}: {
  employee: Employee
  cards: CardNumber[]
  write: Write
  guardLast: (card: CardNumber, title: string, run: () => Promise<void>) => Promise<void>
  ask: Ask
}) {
  const [adding, setAdding] = useState(false)
  return (
    <Card className="p-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-gray-900">{displayName(e.fullName)}</span>
        {e.email && <span className="text-xs text-gray-400">{e.email}</span>}
        {!e.active && <StatusBadge tone="neutral">left</StatusBadge>}
      </div>

      {cards.length === 0 && !adding && <p className="text-sm text-gray-400">No cards.</p>}
      <div className="space-y-2">
        {cards.map((c) => (
          <CardRow key={c.id} card={c} write={write} guardLast={guardLast} ask={ask} />
        ))}
      </div>

      {adding ? (
        <CardForm
          onCancel={() => setAdding(false)}
          onSave={async (v) => {
            const err = await write(() => addCard({ kind: 'employee_card', employeeId: e.id, last4: v.last4, issuer: v.issuer }), { last4: v.last4 })
            if (!err) setAdding(false)
            return err
          }}
        />
      ) : (
        <Button variant="ghost" className="mt-2 px-2" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add card
        </Button>
      )}
    </Card>
  )
}

function CardRow({
  card: c, write, guardLast, ask,
}: {
  card: CardNumber
  write: Write
  guardLast: (card: CardNumber, title: string, run: () => Promise<void>) => Promise<void>
  ask: Ask
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (editing) {
    return (
      <CardForm
        initial={{ last4: c.last4, issuer: c.issuer ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const err = await write(() => updateCard(c.id, { last4: v.last4, issuer: v.issuer.trim() }), c.active ? { last4: v.last4, exceptId: c.id } : undefined)
          if (!err) setEditing(false)
          return err
        }}
      />
    )
  }

  return (
    <div>
      <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 text-sm', !c.active && 'bg-gray-50 text-gray-400')}>
        <span className="w-16 text-gray-600">{c.issuer}</span>
        <span className="font-mono text-gray-900">•••• {c.last4}</span>
        {!c.active && <StatusBadge tone="neutral">closed</StatusBadge>}
        <div className="flex-1" />
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEditing(true)} aria-label="Edit card">
          <Pencil size={13} />
        </Button>
        {c.active ? (
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs"
            onClick={() => guardLast(c, 'Close this card?', async () => setError(await write(() => updateCard(c.id, { active: false }))))}
          >
            Close
          </Button>
        ) : (
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={async () => setError(await write(() => updateCard(c.id, { active: true }), { last4: c.last4, exceptId: c.id }))}>
            Reopen
          </Button>
        )}
        <Button
          variant="ghost"
          aria-label="Delete card"
          className="h-8 px-2 text-gray-400 hover:text-red-600"
          onClick={() =>
            ask({
              title: `Delete ${c.issuer ?? ''} ${c.last4}?`,
              body: 'Delete is for a mistyped number. A card that was closed or reissued should be closed instead.',
              cta: 'Delete',
              run: () => guardLast(c, 'Delete the last card?', async () => setError(await write(() => deleteCard(c.id)))),
            })
          }
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Номер + эмитент. Номер — текстовое поле с маской на 4 цифры: число съело бы ведущий ноль. */
function CardForm({
  initial, onSave, onCancel, withReason,
}: {
  initial?: { last4: string; issuer: string; reason?: string }
  onSave: (v: { last4: string; issuer: string; reason: string }) => Promise<string | null>
  onCancel: () => void
  /** Общая карта: у неё обязательное пояснение (CHECK в базе). */
  withReason?: boolean
}) {
  const [last4, setLast4] = useState(initial?.last4 ?? '')
  const [issuer, setIssuer] = useState(initial?.issuer ?? 'Chase')
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const custom = !ISSUERS.includes(issuer as (typeof ISSUERS)[number])

  async function submit() {
    const err = validateIssuer(issuer) ?? validateLast4(last4) ?? (withReason ? validateReason(reason) : null)
    if (err) return setError(err)
    setBusy(true)
    setError(await onSave({ last4, issuer, reason }))
    setBusy(false)
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {ISSUERS.map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIssuer(i)}
            className={cn('rounded-full border px-3 py-1 text-xs', issuer === i ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600')}
          >
            {i}
          </button>
        ))}
        <Input
          className={cn('max-w-[9rem] text-xs', custom && 'border-blue-600')}
          placeholder="Other bank"
          value={custom ? issuer : ''}
          onChange={(e) => setIssuer(e.target.value)}
        />
        <Input
          className="max-w-[6rem] font-mono"
          inputMode="numeric"
          placeholder="0034"
          aria-label="Last four digits"
          value={last4}
          onChange={(e) => setLast4(maskLast4(e.target.value))}
        />
        <Button variant="primary" className="h-9" disabled={busy} onClick={submit}>Save</Button>
        <Button variant="ghost" className="h-9" onClick={onCancel}>Cancel</Button>
      </div>
      {withReason && (
        <Textarea
          className="mt-2 text-sm"
          rows={2}
          placeholder="Who uses it and how the buyer is recorded — e.g. goes to new employees; the bookkeeper adds the person on each receipt"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/* ---------------- общая (запасная) карта ---------------- */

function SharedCardSection({
  cards, write, guardLast, ask,
}: {
  cards: CardNumber[]
  write: Write
  guardLast: (card: CardNumber, title: string, run: () => Promise<void>) => Promise<void>
  ask: Ask
}) {
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Shared card</h2>
      <p className="mb-3 text-sm text-gray-500">
        The company’s spare card passes from person to person, so it is never tied to anyone. It is not reported as unknown; the
        bookkeeper adds the buyer on its receipts by hand.
      </p>
      <Card className="space-y-2 p-5">
        {cards.map((c) => (
          <SharedCardRow key={c.id} card={c} write={write} guardLast={guardLast} ask={ask} />
        ))}
        {cards.length === 0 && !adding && <p className="text-sm text-gray-400">None.</p>}
        {adding ? (
          <CardForm
            withReason
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const err = await write(() => addCard({ kind: 'shared_card', last4: v.last4, issuer: v.issuer, reason: v.reason }), { last4: v.last4 })
              if (!err) setAdding(false)
              return err
            }}
          />
        ) : (
          <Button variant="ghost" className="px-2" onClick={() => setAdding(true)}>
            <Plus size={15} /> Add a shared card
          </Button>
        )}
      </Card>
    </section>
  )
}

function SharedCardRow({
  card: c, write, guardLast, ask,
}: {
  card: CardNumber
  write: Write
  guardLast: (card: CardNumber, title: string, run: () => Promise<void>) => Promise<void>
  ask: Ask
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (editing) {
    return (
      <CardForm
        withReason
        initial={{ last4: c.last4, issuer: c.issuer ?? '', reason: c.reason ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const err = await write(
            () => updateCard(c.id, { last4: v.last4, issuer: v.issuer.trim(), reason: v.reason.trim() }),
            c.active ? { last4: v.last4, exceptId: c.id } : undefined,
          )
          if (!err) setEditing(false)
          return err
        }}
      />
    )
  }
  return (
    <div>
      <div className={cn('rounded-lg border border-gray-100 px-3 py-2 text-sm', !c.active && 'bg-gray-50 text-gray-400')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-gray-600">{c.issuer}</span>
          <span className="font-mono text-gray-900">•••• {c.last4}</span>
          {!c.active && <StatusBadge tone="neutral">closed</StatusBadge>}
          <div className="flex-1" />
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEditing(true)} aria-label="Edit shared card">
            <Pencil size={13} />
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs"
            onClick={async () =>
              c.active
                ? guardLast(c, 'Close the shared card?', async () => setError(await write(() => updateCard(c.id, { active: false }))))
                : setError(await write(() => updateCard(c.id, { active: true }), { last4: c.last4, exceptId: c.id }))
            }
          >
            {c.active ? 'Close' : 'Reopen'}
          </Button>
          <Button
            variant="ghost"
            aria-label="Delete shared card"
            className="h-8 px-2 text-gray-400 hover:text-red-600"
            onClick={() =>
              ask({
                title: `Delete ${c.issuer ?? ''} ${c.last4}?`,
                body: 'Delete is for a mistyped number. Once deleted, receipts on this card are reported again as a number nobody owns.',
                cta: 'Delete',
                run: async () => setError(await write(() => deleteCard(c.id))),
              })
            }
          >
            <Trash2 size={14} />
          </Button>
        </div>
        {c.reason && <p className="mt-1 text-xs text-gray-500">{c.reason}</p>}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/* ---------------- номера, которые не карты ---------------- */

function NotACardSection({ cards, write, ask }: { cards: CardNumber[]; write: Write; ask: Ask }) {
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Numbers that are not cards</h2>
      <p className="mb-3 text-sm text-gray-500">Bank, loan or utility account numbers printed where a card number would be.</p>
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <span>A number recorded here is never reported to anybody. A real card put in this list goes silent for good — record only numbers you are sure are not a card.</span>
      </div>
      <Card className="space-y-2 p-5">
        {cards.map((c) => (
          <NotACardRow key={c.id} card={c} write={write} ask={ask} />
        ))}
        {cards.length === 0 && !adding && <p className="text-sm text-gray-400">None.</p>}
        {adding ? (
          <NotACardForm
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const err = await write(() => addCard({ kind: 'not_a_card', last4: v.last4, reason: v.reason }), { last4: v.last4 })
              if (!err) setAdding(false)
              return err
            }}
          />
        ) : (
          <Button variant="ghost" className="px-2" onClick={() => setAdding(true)}>
            <Plus size={15} /> Add a number
          </Button>
        )}
      </Card>
    </section>
  )
}

function NotACardRow({ card: c, write, ask }: { card: CardNumber; write: Write; ask: Ask }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (editing) {
    return (
      <NotACardForm
        initial={{ last4: c.last4, reason: c.reason ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const err = await write(() => updateCard(c.id, { last4: v.last4, reason: v.reason.trim() }), c.active ? { last4: v.last4, exceptId: c.id } : undefined)
          if (!err) setEditing(false)
          return err
        }}
      />
    )
  }
  return (
    <div>
      <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 text-sm', !c.active && 'bg-gray-50 text-gray-400')}>
        <span className="font-mono text-gray-900">{c.last4}</span>
        <span className="min-w-0 flex-1 text-gray-600">{c.reason}</span>
        {!c.active && <StatusBadge tone="neutral">off</StatusBadge>}
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil size={13} />
        </Button>
        <Button
          variant="ghost"
          className="h-8 px-2 text-xs"
          onClick={async () =>
            setError(await write(() => updateCard(c.id, { active: !c.active }), c.active ? undefined : { last4: c.last4, exceptId: c.id }))
          }
        >
          {c.active ? 'Turn off' : 'Turn on'}
        </Button>
        <Button
          variant="ghost"
          aria-label="Delete"
          className="h-8 px-2 text-gray-400 hover:text-red-600"
          onClick={() =>
            ask({
              title: `Delete ${c.last4}?`,
              body: 'Once deleted, receipts with this number are reported again as a number nobody owns.',
              cta: 'Delete',
              run: async () => setError(await write(() => deleteCard(c.id))),
            })
          }
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

function NotACardForm({
  initial, onSave, onCancel,
}: {
  initial?: { last4: string; reason: string }
  onSave: (v: { last4: string; reason: string }) => Promise<string | null>
  onCancel: () => void
}) {
  const [last4, setLast4] = useState(initial?.last4 ?? '')
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit() {
    const err = validateLast4(last4) ?? validateReason(reason)
    if (err) return setError(err)
    setBusy(true)
    setError(await onSave({ last4, reason }))
    setBusy(false)
  }
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-[6rem] font-mono" inputMode="numeric" placeholder="0034" aria-label="Last four digits" value={last4} onChange={(e) => setLast4(maskLast4(e.target.value))} />
        <Input className="min-w-[14rem] flex-1" placeholder="What it is — e.g. Pepco account number" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button variant="primary" className="h-9" disabled={busy} onClick={submit}>Save</Button>
        <Button variant="ghost" className="h-9" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
