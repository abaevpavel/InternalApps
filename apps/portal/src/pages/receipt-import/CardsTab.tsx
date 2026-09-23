import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Card, Input, StatusBadge, Textarea } from '../../components/ui'
import { usePendingActions } from '../../app/PendingActions'
import { cn, errMsg } from '../../lib/utils'
import {
  DuplicateNumberError, addCard, addEmployee, deleteCard, loadCardsData, loadDirectoryOptions, syncEmployeesNow, updateCard, type NewPerson,
} from '../../services/receipt-cards'
import {
  ISSUERS, cardsOf, displayName, holderOf, lastSync, maskLast4, removesLastCard, validateIssuer, validateLast4, validateReason,
  type CardNumber, type Employee,
} from '../../domain/receipt-cards'

/**
 * Receipts Matcher · сотрудники и номера карт (BAS-1472).
 *
 * Люди приходят из Airtable «All employees» синком (раз в сутки + «Sync now») — завести человека
 * здесь нельзя по решению задачи: сотрудник, которого нет в Airtable, не может попасть на чек.
 * Карты живут только здесь — это единственная копия списка.
 *
 * Каждая запись — через подтверждение и 10 секунд на отмену (PendingActions): после «да» форма
 * закрывается, а запись уходит, когда выйдет время.
 */

/** Одно действие над картами: подтверждение → 10 с на отмену → запись. */
interface ActSpec {
  title: string
  body: ReactNode
  cta: string
  danger?: boolean
  /** Подпись в плашке отсчёта: «Adding Chase 0034 to Oscar Herrera». */
  label: string
  run: () => Promise<void>
  /** Проверить занятость номера ДО подтверждения — понятная фраза, кто его держит. */
  dupCheck?: { last4: string; exceptId?: string }
  /** Действие снимает эту карту с активных — предупредить, если она последняя во всей таблице. */
  removes?: CardNumber
}
/** `error` — отказ до подтверждения (дубль); `scheduled` — человек подтвердил, запись в очереди. */
type Act = (s: ActSpec) => Promise<{ error: string | null; scheduled: boolean }>

export function CardsTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['receipt-cards'], queryFn: loadCardsData })
  const { confirmAndSchedule } = usePendingActions()
  const [search, setSearch] = useState('')
  const [showLeft, setShowLeft] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [addingPerson, setAddingPerson] = useState(false)

  const employees = q.data?.employees ?? []
  const cards = q.data?.cards ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: ['receipt-cards'] })

  const act: Act = async (s) => {
    if (s.dupCheck) {
      const held = holderOf(s.dupCheck.last4, cards, employees, s.dupCheck.exceptId)
      if (held) return { error: held, scheduled: false }
    }
    // Автоматизация на пустом списке карт не работает — снять последнюю можно, но осознанно.
    const last = s.removes ? removesLastCard(s.removes, cards) : false
    const body = last ? (
      <>
        {s.body}
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-900">
          This is the last active card in the whole list. The receipts automation refuses to run on an empty card list, so no receipt
          will be matched to anybody until a card is added again.
        </p>
      </>
    ) : (
      s.body
    )
    const scheduled = await confirmAndSchedule(
      { title: s.title, body, cta: s.cta, danger: s.danger || last },
      {
        label: s.label,
        run: async () => {
          try {
            await s.run()
          } catch (e) {
            // Кто-то успел раньше: отказ unique-индекса — в человеческую фразу.
            if (e instanceof DuplicateNumberError && s.dupCheck) {
              throw new Error(`${s.dupCheck.last4} is already in use — the list has been reloaded, see who holds it.`)
            }
            throw e
          } finally {
            await refresh()
          }
        },
      },
    )
    return { error: null, scheduled }
  }

  function syncNow() {
    setSyncResult(null)
    void confirmAndSchedule(
      {
        title: 'Sync employees from Airtable now?',
        body: 'Names and emails are updated from Airtable “All employees”; people no longer there are marked as left. Cards are not touched.',
        cta: 'Sync',
      },
      {
        label: 'Syncing employees',
        doneLabel: 'Employees synced',
        run: async () => {
          try {
            const r = await syncEmployeesNow()
            setSyncResult(`Synced ${r.fetched} people from Airtable: ${r.added} added, ${r.updated} updated, ${r.reactivated} back, ${r.deactivated} left.`)
          } finally {
            await refresh()
          }
        },
      },
    )
  }

  /**
   * Новый человек: строка создаётся СРАЗУ по-настоящему в 05-Contacts Directory — общем
   * справочнике компании (оттуда же Task Planner берёт бригады). Поэтому — подтверждение, 10 с
   * и предупреждение о дубле. Дубль по справочнику функция проверяет ещё раз сама.
   */
  async function addPerson(v: NewPerson): Promise<{ error: string | null; scheduled: boolean }> {
    const fullName = `${v.firstName} ${v.lastName}`
    const norm = (x: string) => displayName(x).toLowerCase()
    const same = employees.find((e) => norm(e.fullName) === norm(fullName))
    const scheduled = await confirmAndSchedule(
      {
        title: `Add ${fullName}?`,
        body: (
          <>
            A new employee is created in the Airtable <b>Contacts Directory</b>
            {v.email ? <> with {v.email}</> : null}
            {v.title ? <>, {v.title}</> : null}
            {v.departments.length ? <> ({v.departments.join(', ')})</> : null} — the company-wide directory. They appear here once Airtable syncs All employees
            (usually within minutes) and you press Sync now; then they can be given cards.
            {same && (
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-900">
                {displayName(same.fullName)} is already in the list{same.active ? '' : ' (left)'}. Adding again creates a second person
                in Airtable — only do this if it really is someone else.
              </p>
            )}
          </>
        ),
        cta: 'Add person',
        danger: !!same,
      },
      {
        label: `Adding ${fullName}`,
        doneLabel: `${fullName} added to the Contacts Directory — Sync now in a few minutes`,
        run: async () => {
          try {
            const r = await addEmployee(v)
            if (r.warning) setSyncResult(r.warning)
          } finally {
            await refresh()
          }
        },
      },
    )
    return { error: null, scheduled }
  }

  const needle = search.trim().toLowerCase()
  const active = useMemo(
    () =>
      employees.filter(
        (e) =>
          e.active &&
          (!needle || displayName(e.fullName).toLowerCase().includes(needle) || cards.some((c) => c.employeeId === e.id && c.last4.includes(needle))),
      ),
    [employees, cards, needle],
  )
  const left = employees.filter((e) => !e.active)
  const byKind = (k: CardNumber['kind']) =>
    cards.filter((c) => c.kind === k).sort((a, b) => Number(b.active) - Number(a.active) || a.last4.localeCompare(b.last4))

  if (q.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (q.error) return <p className="text-sm text-red-600">{errMsg(q.error)}</p>

  const synced = lastSync(employees)

  return (
    <div className="max-w-5xl space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 text-sm text-gray-600">
            <p>
              People come from Airtable <span className="font-medium">All employees</span> once a day. <em>Add person</em> creates them
              in the Contacts Directory; they appear here after Airtable syncs All employees and the next sync runs. Someone removed
              from Airtable stays here as <em>left</em>, with their cards kept.
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {synced ? `Last synced ${new Date(synced).toLocaleString('en-US')}` : 'Not synced yet.'}
            </p>
          </div>
          <Button onClick={syncNow}>
            <RefreshCw size={15} /> Sync now
          </Button>
        </div>
        {syncResult && <p className="mt-3 text-sm text-green-700">{syncResult}</p>}
      </Card>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-900">Employees and their cards</h2>
          <div className="flex items-center gap-2">
            <Input className="max-w-xs" placeholder="Search by name or last four digits" value={search} onChange={(e) => setSearch(e.target.value)} />
            {!addingPerson && (
              <Button className="shrink-0" onClick={() => setAddingPerson(true)}>
                <Plus size={15} /> Add person
              </Button>
            )}
          </div>
        </div>
        {addingPerson && (
          <PersonForm
            onCancel={() => setAddingPerson(false)}
            onSave={async (v) => {
              const r = await addPerson(v)
              if (r.scheduled) setAddingPerson(false)
              return r.error
            }}
          />
        )}
        {/* Две колонки: у человека обычно 1–4 карты, на всю ширину карточка была пустой. */}
        <div className="grid items-start gap-3 md:grid-cols-2">
          {active.map((e) => (
            <EmployeeBlock key={e.id} employee={e} cards={cardsOf(e.id, cards)} act={act} />
          ))}
          {active.length === 0 && <p className="text-sm text-gray-500">Nobody matches.</p>}
        </div>

        {left.length > 0 && (
          <div className="mt-4">
            <button type="button" className="text-sm text-gray-500 hover:text-gray-800" onClick={() => setShowLeft((v) => !v)}>
              {showLeft ? 'Hide' : 'Show'} people no longer in Airtable ({left.length})
            </button>
            {showLeft && (
              <div className="mt-3 grid items-start gap-3 opacity-80 md:grid-cols-2">
                {left.map((e) => (
                  <EmployeeBlock key={e.id} employee={e} cards={cardsOf(e.id, cards)} act={act} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <SharedCardSection cards={byKind('shared_card')} act={act} />
      <NotACardSection cards={byKind('not_a_card')} act={act} />
    </div>
  )
}

/* ---------------- новый человек ---------------- */

const HEADSHOT_MAX_BYTES = 3 * 1024 * 1024

function PersonForm({
  onSave, onCancel,
}: {
  onSave: (v: NewPerson) => Promise<string | null>
  onCancel: () => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [departments, setDepartments] = useState<string[]>([])
  const [headshot, setHeadshot] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Варианты — из самого справочника: те отделы и должности, что уже стоят у сотрудников.
  const opts = useQuery({ queryKey: ['directory-options'], queryFn: loadDirectoryOptions, staleTime: 5 * 60_000 })
  const preview = useMemo(() => (headshot ? URL.createObjectURL(headshot) : null), [headshot])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function pickHeadshot(f: File | null) {
    setError(null)
    if (f && !f.type.startsWith('image/')) return setError('The headshot must be an image.')
    if (f && f.size > HEADSHOT_MAX_BYTES) return setError('The headshot is larger than 3 MB.')
    setHeadshot(f)
  }

  async function submit() {
    if (!firstName.trim() || !lastName.trim()) return setError('Enter both the first and the last name.')
    if (email.trim() && !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email.trim())) return setError('This does not look like an email address.')
    setError(await onSave({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), title: title.trim(), departments, headshot }))
  }
  return (
    <Card className="mb-3 p-3">
      <p className="mb-2 text-xs text-gray-500">
        Created as an employee in the Airtable Contacts Directory (the company-wide directory). Their name there becomes “First Last”.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 min-w-[9rem] flex-1 py-1 text-sm" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <Input className="h-8 min-w-[9rem] flex-1 py-1 text-sm" placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        <Input className="h-8 min-w-[12rem] flex-1 py-1 text-sm" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          className="h-8 min-w-[14rem] flex-1 py-1 text-sm"
          placeholder="Title / position (optional)"
          list="directory-titles"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <datalist id="directory-titles">
          {(opts.data?.titles ?? []).map((t) => <option key={t} value={t} />)}
        </datalist>
        <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 text-xs text-gray-600 hover:bg-gray-50">
          {preview ? <img src={preview} alt="" className="h-6 w-6 rounded-full object-cover" /> : null}
          {headshot ? headshot.name : 'Headshot (optional, up to 3 MB)'}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { pickHeadshot(e.target.files?.[0] ?? null); e.target.value = '' }} />
        </label>
        {headshot && (
          <button type="button" className="text-xs text-gray-500 hover:text-gray-800" onClick={() => setHeadshot(null)}>Remove photo</button>
        )}
      </div>

      <div className="mt-2">
        <p className="mb-1 text-xs text-gray-500">Department</p>
        {opts.isLoading && <p className="text-xs text-gray-400">Loading departments…</p>}
        {opts.error && <p className="text-xs text-red-600">{errMsg(opts.error)}</p>}
        <div className="flex flex-wrap gap-1.5">
          {(opts.data?.departments ?? []).map((d) => {
            const on = departments.includes(d)
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDepartments((cur) => (on ? cur.filter((x) => x !== d) : [...cur, d]))}
                className={cn('rounded-full border px-2.5 py-0.5 text-[11px]', on ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600')}
              >
                {d}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" className="h-8 px-3 text-xs" onClick={submit}>Add</Button>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={onCancel}>Cancel</Button>
        <span className="text-[11px] text-gray-400">Everything else (reporting line, phone, …) — fill in directly in the Airtable Contacts Directory.</span>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  )
}

/* ---------------- сотрудник ---------------- */

function EmployeeBlock({ employee: e, cards, act }: { employee: Employee; cards: CardNumber[]; act: Act }) {
  const [adding, setAdding] = useState(false)
  const who = displayName(e.fullName)
  return (
    <Card className="px-4 py-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-gray-900">{who}</span>
        {e.email && <span className="truncate text-[11px] text-gray-400">{e.email}</span>}
        {!e.active && <StatusBadge tone="neutral">left</StatusBadge>}
      </div>

      {cards.length === 0 && !adding && <p className="py-1 text-xs text-gray-400">No cards.</p>}
      <div className="divide-y divide-gray-100">
        {cards.map((c) => (
          <CardRow key={c.id} card={c} owner={who} act={act} />
        ))}
      </div>

      {adding ? (
        <CardForm
          onCancel={() => setAdding(false)}
          onSave={async (v) => {
            const r = await act({
              title: `Add ${v.issuer} ${v.last4} to ${who}?`,
              body: <>Receipts paid with this card will be attributed to <b>{who}</b>.</>,
              cta: 'Add card',
              label: `Adding ${v.issuer} ${v.last4} to ${who}`,
              run: () => addCard({ kind: 'employee_card', employeeId: e.id, last4: v.last4, issuer: v.issuer }),
              dupCheck: { last4: v.last4 },
            })
            if (r.scheduled) setAdding(false)
            return r.error
          }}
        />
      ) : (
        <Button variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add card
        </Button>
      )}
    </Card>
  )
}

/** Общие действия строки: исправить, закрыть/открыть, удалить. */
function RowActions({
  card: c, name, act, onEdit, onError, compact,
}: { card: CardNumber; name: string; act: Act; onEdit: () => void; onError: (e: string | null) => void; compact?: boolean }) {
  const closeWord = c.kind === 'not_a_card' ? 'Turn off' : 'Close'
  const openWord = c.kind === 'not_a_card' ? 'Turn on' : 'Reopen'
  const btn = compact ? 'h-6 px-1.5 text-[11px]' : 'h-8 px-2 text-xs'
  return (
    <>
      <Button variant="ghost" className={btn} onClick={onEdit} aria-label="Edit">
        <Pencil size={13} />
      </Button>
      <Button
        variant="ghost"
        className={btn}
        onClick={async () => {
          const r = c.active
            ? await act({
                title: `${closeWord} ${name}?`,
                body:
                  c.kind === 'not_a_card'
                    ? 'Receipts with this number will be reported again as a number nobody owns.'
                    : 'Use this when the card was closed or reissued. It stays in the list as closed and can be reopened.',
                cta: closeWord,
                label: `${closeWord === 'Close' ? 'Closing' : 'Turning off'} ${name}`,
                run: () => updateCard(c.id, { active: false }),
                removes: c,
              })
            : await act({
                title: `${openWord} ${name}?`,
                body: 'The number becomes active again.',
                cta: openWord,
                label: `${openWord === 'Reopen' ? 'Reopening' : 'Turning on'} ${name}`,
                run: () => updateCard(c.id, { active: true }),
                dupCheck: { last4: c.last4, exceptId: c.id },
              })
          onError(r.error)
        }}
      >
        {c.active ? closeWord : openWord}
      </Button>
      <Button
        variant="ghost"
        aria-label="Delete"
        className={cn(btn, 'text-gray-400 hover:text-red-600')}
        onClick={async () => {
          const r = await act({
            title: `Delete ${name}?`,
            body:
              c.kind === 'employee_card'
                ? 'Delete is for a mistyped number. A card that was closed or reissued should be closed instead.'
                : 'Once deleted, receipts with this number are reported again as a number nobody owns.',
            cta: 'Delete',
            danger: true,
            label: `Deleting ${name}`,
            run: () => deleteCard(c.id),
            removes: c,
          })
          onError(r.error)
        }}
      >
        <Trash2 size={14} />
      </Button>
    </>
  )
}

function CardRow({ card: c, owner, act }: { card: CardNumber; owner: string; act: Act }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = `${c.issuer ?? ''} ${c.last4}`.trim()

  if (editing) {
    return (
      <CardForm
        initial={{ last4: c.last4, issuer: c.issuer ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const r = await act({
            title: `Change ${name} to ${v.issuer} ${v.last4}?`,
            body: <>The card stays on <b>{owner}</b>.</>,
            cta: 'Save',
            label: `Saving ${v.issuer} ${v.last4}`,
            run: () => updateCard(c.id, { last4: v.last4, issuer: v.issuer.trim() }),
            dupCheck: c.active ? { last4: v.last4, exceptId: c.id } : undefined,
          })
          if (r.scheduled) setEditing(false)
          return r.error
        }}
      />
    )
  }

  return (
    <div>
      <div className={cn('flex items-center gap-2 py-1 text-xs', !c.active && 'text-gray-400')}>
        <span className="w-12 shrink-0 text-gray-500">{c.issuer}</span>
        <span className={cn('font-mono', c.active ? 'text-gray-900' : 'text-gray-400 line-through')}>•••• {c.last4}</span>
        {!c.active && <span className="text-[10px] uppercase tracking-wide text-gray-400">closed</span>}
        <div className="flex-1" />
        <RowActions card={c} name={`${name} (${owner})`} act={act} onEdit={() => setEditing(true)} onError={setError} compact />
      </div>
      {error && <p className="pb-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Номер + эмитент (+ заметка у общей карты). Номер — текст с маской: число съело бы ведущий ноль. */
function CardForm({
  initial, onSave, onCancel, withReason,
}: {
  initial?: { last4: string; issuer: string; reason?: string }
  onSave: (v: { last4: string; issuer: string; reason: string }) => Promise<string | null>
  onCancel: () => void
  /** Общая карта: у неё обязательная заметка (CHECK в базе). */
  withReason?: boolean
}) {
  const [last4, setLast4] = useState(initial?.last4 ?? '')
  const [issuer, setIssuer] = useState(initial?.issuer ?? 'Chase')
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [error, setError] = useState<string | null>(null)
  const custom = !ISSUERS.includes(issuer as (typeof ISSUERS)[number])

  async function submit() {
    const err = validateIssuer(issuer) ?? validateLast4(last4) ?? (withReason ? validateReason(reason) : null)
    if (err) return setError(err)
    setError(await onSave({ last4, issuer, reason }))
  }

  return (
    <div className="my-1 rounded-lg border border-gray-200 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {ISSUERS.map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIssuer(i)}
            className={cn('rounded-full border px-2.5 py-0.5 text-[11px]', issuer === i ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600')}
          >
            {i}
          </button>
        ))}
        <Input
          className={cn('h-7 max-w-[7rem] py-1 text-xs', custom && 'border-blue-600')}
          placeholder="Other bank"
          value={custom ? issuer : ''}
          onChange={(e) => setIssuer(e.target.value)}
        />
        <Input
          className="h-7 max-w-[4.5rem] py-1 font-mono text-xs"
          inputMode="numeric"
          placeholder="0034"
          aria-label="Last four digits"
          value={last4}
          onChange={(e) => setLast4(maskLast4(e.target.value))}
        />
        <Button variant="primary" className="h-7 px-3 text-xs" onClick={submit}>Save</Button>
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onCancel}>Cancel</Button>
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

function SharedCardSection({ cards, act }: { cards: CardNumber[]; act: Act }) {
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
          <SharedCardRow key={c.id} card={c} act={act} />
        ))}
        {cards.length === 0 && !adding && <p className="text-sm text-gray-400">None.</p>}
        {adding ? (
          <CardForm
            withReason
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const r = await act({
                title: `Add ${v.issuer} ${v.last4} as a shared card?`,
                body: 'Receipts on this card will not be attributed to anyone; the bookkeeper adds the buyer by hand.',
                cta: 'Add',
                label: `Adding shared card ${v.issuer} ${v.last4}`,
                run: () => addCard({ kind: 'shared_card', last4: v.last4, issuer: v.issuer, reason: v.reason }),
                dupCheck: { last4: v.last4 },
              })
              if (r.scheduled) setAdding(false)
              return r.error
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

function SharedCardRow({ card: c, act }: { card: CardNumber; act: Act }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = `${c.issuer ?? ''} ${c.last4}`.trim()
  if (editing) {
    return (
      <CardForm
        withReason
        initial={{ last4: c.last4, issuer: c.issuer ?? '', reason: c.reason ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const r = await act({
            title: `Save the shared card ${v.issuer} ${v.last4}?`,
            body: 'The number, bank and note of the shared card are updated.',
            cta: 'Save',
            label: `Saving shared card ${v.issuer} ${v.last4}`,
            run: () => updateCard(c.id, { last4: v.last4, issuer: v.issuer.trim(), reason: v.reason.trim() }),
            dupCheck: c.active ? { last4: v.last4, exceptId: c.id } : undefined,
          })
          if (r.scheduled) setEditing(false)
          return r.error
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
          <RowActions card={c} name={`shared card ${name}`} act={act} onEdit={() => setEditing(true)} onError={setError} />
        </div>
        {c.reason && <p className="mt-1 text-xs text-gray-500">{c.reason}</p>}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/* ---------------- номера, которые не карты ---------------- */

function NotACardSection({ cards, act }: { cards: CardNumber[]; act: Act }) {
  const [adding, setAdding] = useState(false)
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Numbers that are not cards</h2>
      <p className="mb-3 text-sm text-gray-500">Bank, loan or utility account numbers printed where a card number would be.</p>
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>A number recorded here is never reported to anybody. A real card put in this list goes silent for good — record only numbers you are sure are not a card.</span>
      </div>
      {/* Плотный список: номеров много, а читают их глазами сверху вниз. */}
      <Card className="px-3 py-1.5">
        <div className="divide-y divide-gray-100">
          {cards.map((c) => (
            <NotACardRow key={c.id} card={c} act={act} />
          ))}
        </div>
        {cards.length === 0 && !adding && <p className="py-1 text-xs text-gray-400">None.</p>}
        {adding ? (
          <NotACardForm
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const r = await act({
                title: `Record ${v.last4} as not a card?`,
                body: <>Receipts with <b>{v.last4}</b> will never be reported to anybody. Make sure it is not a real card.</>,
                cta: 'Record',
                danger: true,
                label: `Recording ${v.last4} as not a card`,
                run: () => addCard({ kind: 'not_a_card', last4: v.last4, reason: v.reason }),
                dupCheck: { last4: v.last4 },
              })
              if (r.scheduled) setAdding(false)
              return r.error
            }}
          />
        ) : (
          <Button variant="ghost" className="my-1 h-7 px-2 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add a number
          </Button>
        )}
      </Card>
    </section>
  )
}

function NotACardRow({ card: c, act }: { card: CardNumber; act: Act }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (editing) {
    return (
      <NotACardForm
        initial={{ last4: c.last4, reason: c.reason ?? '' }}
        onCancel={() => setEditing(false)}
        onSave={async (v) => {
          const r = await act({
            title: `Save ${v.last4}?`,
            body: 'The number and its reason are updated.',
            cta: 'Save',
            label: `Saving ${v.last4}`,
            run: () => updateCard(c.id, { last4: v.last4, reason: v.reason.trim() }),
            dupCheck: c.active ? { last4: v.last4, exceptId: c.id } : undefined,
          })
          if (r.scheduled) setEditing(false)
          return r.error
        }}
      />
    )
  }
  return (
    <div>
      <div className={cn('flex items-center gap-2 py-1 text-xs', !c.active && 'text-gray-400')}>
        <span className={cn('w-10 shrink-0 font-mono', c.active ? 'text-gray-900' : 'text-gray-400 line-through')}>{c.last4}</span>
        <span className="min-w-0 flex-1 truncate text-gray-600" title={c.reason ?? ''}>{c.reason}</span>
        {!c.active && <span className="text-[10px] uppercase tracking-wide text-gray-400">off</span>}
        <RowActions card={c} name={c.last4} act={act} onEdit={() => setEditing(true)} onError={setError} compact />
      </div>
      {error && <p className="pb-1 text-xs text-red-600">{error}</p>}
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
  async function submit() {
    const err = validateLast4(last4) ?? validateReason(reason)
    if (err) return setError(err)
    setError(await onSave({ last4, reason }))
  }
  return (
    <div className="my-1 rounded-lg border border-gray-200 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 max-w-[5rem] py-1 font-mono text-xs" inputMode="numeric" placeholder="0034" aria-label="Last four digits" value={last4} onChange={(e) => setLast4(maskLast4(e.target.value))} />
        <Input className="h-8 min-w-[14rem] flex-1 py-1 text-xs" placeholder="What it is — e.g. Pepco account number" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button variant="primary" className="h-8 px-3 text-xs" onClick={submit}>Save</Button>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
