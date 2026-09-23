import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, Plus, Trash2 } from 'lucide-react'
import { Button, Card, Dropdown, Field, Input, PageTitle, StatusBadge, Tabs, Textarea } from '../../components/ui'
import { SaveBar } from '../../components/SaveBar'
import { HistoryPanel } from '../../components/HistoryPanel'
import { usePendingActions } from '../../app/PendingActions'
import { errMsg } from '../../lib/utils'
import { useAuth } from '../../auth/AuthProvider'
import { loadBundle, loadListings, saveChanges, saveListings } from '../../services/gmb'
import {
  CTA_OPTIONS, EMAIL_LIST_MAX, GMB_TZ_LABEL, MIN_STARS_OPTIONS, SECTION_ORDER, SECTION_TITLES, WEEKDAYS,
  asRange, asString, asStringList, asTopics, buildCron, describeCron, fieldMeta, fieldRank, normalizeValue,
  parseCron, sameValue, validateValue,
  type GmbRegion, type GmbSection, type GmbSettingKey, type GmbTopic,
} from '../../domain/gmb'
import {
  ENFORCE_OPTIONS, LISTINGS_HELPER, fromChoice, listingChanged, newListingNote, outcome, toChoice,
  type GmbListing,
} from '../../domain/gmb-listings'

/**
 * GMB Agent — экран настроек (BAS-1353).
 *
 * Форма строится по каталогу `gmb."SettingKey"`, а не по захардкоженному списку полей:
 * появится новый ключ — он сам появится в своей секции. Локально известны только подача
 * и валидация (`domain/gmb.ts`).
 *
 * Кто что правит: `editableBy = developer` — только админ портала; `staff` — все, кому
 * апка выдана ролью (гейт роутом, `AppAccessGuard`).
 */
export function GmbAgentSettingsPage() {
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  // 'history' — не секция каталога, а история изменений (portal_audit_log).
  const [tab, setTab] = useState<GmbSection | 'history'>('reviews')
  const [edits, setEdits] = useState<Record<string, unknown>>({})

  const q = useQuery({ queryKey: ['gmb-settings'], queryFn: loadBundle })
  // Названия листингов (BAS-1543) — своя таблица, но одна кнопка Save на весь экран.
  const lq = useQuery({ queryKey: ['gmb-listings'], queryFn: loadListings })
  const [listingEdits, setListingEdits] = useState<Record<string, Pick<GmbListing, 'desiredName' | 'enforceOverride'>>>({})

  const baseline = useMemo(() => {
    const m: Record<string, unknown> = {}
    for (const s of q.data?.settings ?? []) m[s.key] = s.value
    return m
  }, [q.data])

  const keys = q.data?.keys ?? []
  const regions = q.data?.regions ?? []

  /** Текущее значение ключа: правка поверх сохранённого. */
  function valueOf(key: string): unknown {
    return key in edits ? edits[key] : baseline[key]
  }

  function setValue(key: string, v: unknown) {
    setEdits((prev) => ({ ...prev, [key]: v }))
  }

  // Изменённые ключи — сравниваем НОРМАЛИЗОВАННЫЕ значения, иначе лишний пробел
  // в конце строки считался бы правкой.
  const changed = useMemo(() => {
    const out: { key: string; value: unknown }[] = []
    for (const k of keys) {
      if (!(k.key in edits)) continue
      const next = normalizeValue(k.key, k.valueType, edits[k.key])
      if (!sameValue(next, normalizeValue(k.key, k.valueType, baseline[k.key]))) out.push({ key: k.key, value: next })
    }
    return out
  }, [edits, baseline, keys])

  const errors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const err = validateValue(k.key, k.valueType, normalizeValue(k.key, k.valueType, valueOf(k.key)), regions)
      if (err) out[k.key] = err
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, baseline, keys, regions])

  /** Блокируем сохранение только из-за полей, которые человек трогал. */
  const blocking = changed.filter((c) => errors[c.key])

  const listings = useMemo(
    () => (lq.data ?? []).map((l) => (listingEdits[l.locationId] ? { ...l, ...listingEdits[l.locationId] } : l)),
    [lq.data, listingEdits],
  )
  // Только реально изменённые строки: `updated_by` должен говорить правду о том, кто что менял.
  const changedListings = useMemo(
    () => listings.filter((l) => {
      const before = lq.data?.find((b) => b.locationId === l.locationId)
      return before ? listingChanged(before, l) : false
    }),
    [listings, lq.data],
  )

  const { confirmAndSchedule, busy } = usePendingActions()
  const saveM = useMutation({
    mutationFn: async (v: { settings: typeof changed; listings: typeof changedListings; edits: typeof edits; listingEdits: typeof listingEdits }) => {
      if (v.settings.length) await saveChanges(v.settings)
      if (v.listings.length) await saveListings(v.listings)
    },
    // Снимаем только правки, которые ушли в базу и не менялись за 10 секунд ожидания.
    onSuccess: async (_r, v) => {
      setEdits((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(v.edits)) if (prev[k] === v.edits[k]) delete next[k]
        return next
      })
      setListingEdits((prev) => {
        const next = { ...prev }
        for (const k of Object.keys(v.listingEdits)) if (prev[k] === v.listingEdits[k]) delete next[k]
        return next
      })
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['gmb-settings'] }),
        qc.invalidateQueries({ queryKey: ['gmb-listings'] }),
      ])
    },
  })

  if (q.isLoading) return <div className="p-10 text-gray-500">Loading…</div>
  if (q.error) return <div className="p-10 text-red-600">{errMsg(q.error)}</div>

  const sectionKeys = keys.filter((k) => k.section === tab).sort((a, b) => fieldRank(a.key) - fieldRank(b.key))

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-10 pb-32 sm:px-6">
      <PageTitle
        title="GMB Agent — Settings"
        subtitle="What the Google Business Profile agent says and when it runs. Saved values are the values the agent runs with."
      />

      <AgentHeartbeat status={q.data!.status} />
      <AppliedStatus status={q.data!.status} />

      <Tabs
        className="mb-6"
        tabs={[
          ...SECTION_ORDER.filter((s) => keys.some((k) => k.section === s)).map((s): { key: GmbSection | 'history'; label: string } => ({
            key: s,
            label: SECTION_TITLES[s],
          })),
          { key: 'history', label: 'History' },
        ]}
        value={tab}
        onChange={setTab}
      />

      <div className="space-y-5">
        {sectionKeys.map((k) => (
          <SettingCard
            key={k.key}
            entry={k}
            value={valueOf(k.key)}
            onChange={(v) => setValue(k.key, v)}
            error={k.key in edits ? errors[k.key] : undefined}
            dirty={changed.some((c) => c.key === k.key)}
            regions={regions}
            locked={k.editableBy === 'developer' && !isAdmin}
          />
        ))}
      </div>

      {tab === 'history' && <HistoryPanel appUrl="/gmb-agent" />}

      {tab === 'listings' && (
        <ListingNames
          listings={listings}
          loading={lq.isLoading}
          error={lq.error ? errMsg(lq.error) : null}
          dirtyIds={new Set(changedListings.map((l) => l.locationId))}
          onChange={(id, patch) =>
            setListingEdits((prev) => {
              const base = prev[id] ?? lq.data?.find((l) => l.locationId === id)
              return base ? { ...prev, [id]: { desiredName: base.desiredName, enforceOverride: base.enforceOverride, ...patch } } : prev
            })
          }
        />
      )}

      <SaveBar
        count={changed.length + changedListings.length}
        blocking={blocking.length}
        saving={saveM.isPending || busy}
        saved={saveM.isSuccess && changed.length + changedListings.length === 0}
        error={null}
        onSave={() => {
          const parts = [
            ...changed.map((c) => fieldMeta(c.key).label),
            ...changedListings.map((l) => `listing ${l.storeCode ?? l.liveTitle ?? l.locationId}`),
          ]
          const v = { settings: changed, listings: changedListings, edits, listingEdits }
          void confirmAndSchedule(
            {
              title: `Save ${parts.length} ${parts.length === 1 ? 'change' : 'changes'}?`,
              body: (
                <>
                  <b>{parts.join(', ')}</b>. The agent picks settings up on its next poll; listing names apply at the next weekly check.
                </>
              ),
              cta: 'Save',
            },
            { label: `Saving ${parts.length} ${parts.length === 1 ? 'change' : 'changes'}`, run: () => saveM.mutateAsync(v) },
          )
        }}
        onDiscard={() => {
          setEdits({})
          setListingEdits({})
        }}
      />
    </div>
  )
}

/* ---------------- шапка ---------------- */

/**
 * Когда агент последний раз отмечался в `gmb_agent_status`.
 *
 * Тревогу здесь НЕ поднимаем, и это подтверждено: агент пишет строку ТОЛЬКО когда
 * применяет изменения (Никита, 09.09.2026), а не на каждом опросе. Значит долгая тишина
 * означает всего лишь «никто ничего не менял», и по одной строке без истории её не
 * отличить от упавшего агента. Показываем факт и дату, а не вывод. Красным экран говорит
 * только там, где агент сам назвал причину — `applied_error` (см. AppliedStatus).
 */
function AgentHeartbeat({
  status,
}: { status: { updatedAt: string | null; appliedAt: string | null } | null }) {
  const last = status?.updatedAt ?? status?.appliedAt ?? null
  if (!last) return null
  return (
    <p className="mb-4 text-xs text-gray-400">
      The agent last reported at {new Date(last).toLocaleString('en-US')}. It picks changes up on its next
      poll — about two minutes.
    </p>
  )
}

function AppliedStatus({ status }: { status: { appliedAt: string | null; appliedError: string | null } | null }) {
  if (!status) return null
  return (
    <Card className="mb-6 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge tone={status.appliedError ? 'danger' : 'success'}>
          {status.appliedError ? 'Not applied' : 'Applied'}
        </StatusBadge>
        <span className="text-gray-500">
          {status.appliedAt ? `Agent last picked the settings up at ${new Date(status.appliedAt).toLocaleString('en-US')}` : 'The agent has not reported yet.'}
        </span>
      </div>
      {status.appliedError && (
        <p className="mt-2 text-sm text-red-700">
          The agent kept the previous working value: {status.appliedError}
        </p>
      )}
      <p className="mt-2 text-xs text-gray-400">A save takes effect on the agent’s next poll, up to five minutes later.</p>
    </Card>
  )
}

/* ---------------- карточка одного ключа ---------------- */

function SettingCard({
  entry, value, onChange, error, dirty, regions, locked,
}: {
  entry: GmbSettingKey
  value: unknown
  onChange: (v: unknown) => void
  error?: string
  dirty: boolean
  regions: GmbRegion[]
  locked: boolean
}) {
  const meta = fieldMeta(entry.key)
  return (
    <Card className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-gray-900">{meta.label}</span>
        <span className="font-mono text-xs text-gray-400">{entry.key}</span>
        {dirty && <StatusBadge tone="warning">unsaved</StatusBadge>}
      </div>
      {/* `notes` из каталога НЕ показываем: там технические строки вида «plain text, <= 600
          chars», которые повторяют валидацию — её и так делает форма, а счётчик символов
          стоит под полем. Смысл поля объясняет `hint` из domain/gmb.ts. */}
      {meta.hint && <p className="mb-3 text-sm text-gray-500">{meta.hint}</p>}

      <div className={locked ? 'pointer-events-none opacity-50' : undefined}>
        <ValueControl entry={entry} value={value} onChange={onChange} regions={regions} />
      </div>

      {meta.warning && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{meta.warning}</span>
        </div>
      )}
      {locked && <p className="mt-2 text-xs text-gray-400">Only a portal administrator can change this.</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </Card>
  )
}

function ValueControl({
  entry, value, onChange, regions,
}: { entry: GmbSettingKey; value: unknown; onChange: (v: unknown) => void; regions: GmbRegion[] }) {
  const meta = fieldMeta(entry.key)

  if (meta.cronFloor) return <CronControl value={asString(value)} onChange={onChange} />

  switch (entry.valueType) {
    case 'string':
      if (entry.key === 'posts_cta_default') {
        return (
          <Dropdown
            className="max-w-xs"
            value={asString(value)}
            onChange={onChange}
            options={CTA_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
          />
        )
      }
      return <TextControl value={asString(value)} onChange={onChange} rows={meta.rows} maxChars={meta.maxChars} placeholder={meta.placeholder} />
    case 'string_list':
      return <LinesControl value={asStringList(value)} onChange={onChange} />
    case 'email_list':
      return <EmailListControl value={asStringList(value)} onChange={onChange} placeholder={meta.placeholder} />
    case 'text_list':
      return <TextListControl value={asStringList(value)} onChange={onChange} maxChars={meta.maxChars} />
    case 'number':
      // Пять фиксированных вариантов вместо свободного числа. Значение остаётся
      // ЧИСЛОМ: Dropdown работает со строками, поэтому гоняем через String/Number.
      if (entry.key === 'auto_reply_min_stars') {
        return (
          <Dropdown
            className="max-w-xs"
            value={String(value ?? 1)}
            onChange={(v) => onChange(Number(v))}
            options={MIN_STARS_OPTIONS.map((o) => ({ value: String(o.value), label: `${o.value} — ${o.label}` }))}
          />
        )
      }
      return (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            className="max-w-[10rem]"
            value={String(value ?? '')}
            min={meta.min}
            max={meta.max}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
          <span className="text-xs text-gray-400">{meta.min}–{meta.max}</span>
        </div>
      )
    case 'range': {
      const r = asRange(value)
      return (
        <div className="flex items-center gap-2">
          <Input type="number" className="max-w-[7rem]" value={String(r.min)} onChange={(e) => onChange({ ...r, min: Number(e.target.value) })} />
          <span className="text-sm text-gray-400">to</span>
          <Input type="number" className="max-w-[7rem]" value={String(r.max)} onChange={(e) => onChange({ ...r, max: Number(e.target.value) })} />
          <span className="text-xs text-gray-400">words · {meta.min}–{meta.max}</span>
        </div>
      )
    }
    case 'boolean':
      return <Toggle value={!!value} onChange={onChange} />
    case 'topic_table':
      return <TopicTable value={asTopics(value)} onChange={onChange} regions={regions} />
    default:
      return <Textarea rows={3} value={JSON.stringify(value ?? null)} readOnly />
  }
}

/* ---------------- контролы ---------------- */

function TextControl({
  value, onChange, rows, maxChars, placeholder,
}: { value: string; onChange: (v: string) => void; rows?: number; maxChars?: number; placeholder?: string }) {
  const over = !!maxChars && value.length > maxChars
  return (
    <div>
      {rows ? (
        <Textarea rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {maxChars && (
        <p className={'mt-1 text-xs ' + (over ? 'text-red-600' : 'text-gray-400')}>
          {value.length} / {maxChars}
        </p>
      )}
    </div>
  )
}

/** Список строк — по одной в строке. Так короткие списки правятся быстрее всего. */
function LinesControl({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'))
  const joined = value.join('\n')
  // Пришли новые данные (сохранение / сброс) — подтягиваем текст.
  const [seen, setSeen] = useState(joined)
  if (seen !== joined && text === seen) {
    setSeen(joined)
    setText(joined)
  }
  return (
    <div>
      <Textarea
        rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value.split('\n'))
        }}
      />
      <p className="mt-1 text-xs text-gray-400">{value.filter((x) => x.trim()).length} entries · one per line</p>
    </div>
  )
}

/** Длинные тексты списком — каждый в своём поле (примеры постов). */
function TextListControl({
  value, onChange, maxChars,
}: { value: string[]; onChange: (v: string[]) => void; maxChars?: number }) {
  return (
    <div className="space-y-3">
      {value.map((item, i) => (
        <div key={i} className="flex gap-2">
          <div className="flex-1">
            <Textarea rows={4} value={item} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
            {maxChars && (
              <p className={'mt-1 text-xs ' + (item.length > maxChars ? 'text-red-600' : 'text-gray-400')}>
                {item.length} / {maxChars}
              </p>
            )}
          </div>
          <Button variant="ghost" className="h-9 shrink-0 px-2 text-gray-400 hover:text-red-600" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
      <Button variant="outline" onClick={() => onChange([...value, ''])}>
        <Plus size={14} /> Add example
      </Button>
      {value.length === 0 && <p className="text-xs text-gray-400">No examples — the list may stay empty.</p>}
    </div>
  )
}

/** Адреса по одному в строке: добавить / удалить, до 20. Пустой список — «никому», это валидно. */
function EmailListControl({
  value, onChange, placeholder,
}: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-sm text-gray-600">
          Nobody will receive the weekly review email.
        </p>
      )}
      {value.map((item, i) => (
        <div key={i} className="flex gap-2">
          <Input
            type="email"
            className="max-w-md"
            value={item}
            placeholder={placeholder}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button variant="ghost" aria-label="Remove address" className="h-9 shrink-0 px-2 text-gray-400 hover:text-red-600" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
      {value.length < EMAIL_LIST_MAX && (
        <Button variant="ghost" className="px-2" onClick={() => onChange([...value, ''])}>
          <Plus size={15} /> Add address
        </Button>
      )}
    </div>
  )
}

/* ---------------- названия листингов (BAS-1543) ---------------- */

function ListingNames({
  listings, loading, error, dirtyIds, onChange,
}: {
  listings: GmbListing[]
  loading: boolean
  error: string | null
  dirtyIds: Set<string>
  onChange: (id: string, patch: Partial<Pick<GmbListing, 'desiredName' | 'enforceOverride'>>) => void
}) {
  return (
    <div className="mt-8">
      <h2 className="mb-1 text-base font-semibold text-gray-900">Listing names</h2>
      <p className="mb-4 text-sm text-gray-500">{LISTINGS_HELPER}</p>
      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="space-y-3">
        {listings.map((l) => (
          <ListingRow key={l.locationId} listing={l} dirty={dirtyIds.has(l.locationId)} onChange={(p) => onChange(l.locationId, p)} />
        ))}
      </div>
    </div>
  )
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function ListingRow({
  listing: l, dirty, onChange,
}: {
  listing: GmbListing
  dirty: boolean
  onChange: (p: Partial<Pick<GmbListing, 'desiredName' | 'enforceOverride'>>) => void
}) {
  const res = outcome(l)
  const fresh = newListingNote(l)
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-500">
            Google shows: <span className="font-medium text-gray-900">{l.liveTitle ?? '—'}</span>
          </p>
          <p className="text-xs text-gray-400">
            {[l.storeCode, l.address].filter(Boolean).join(' · ')}
          </p>
        </div>
        {dirty && <StatusBadge tone="warning">unsaved</StatusBadge>}
        {l.lastSeenAt && <span className="text-xs text-gray-400">Checked {shortDate(l.lastSeenAt)}</span>}
      </div>

      {fresh && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{fresh.banner}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
        <Field label="Name this listing should keep" hint={l.registryName ? `Agent keeps it as: ${l.registryName}` : undefined}>
          <Input
            value={l.desiredName ?? ''}
            placeholder={l.registryName ?? 'No name set'}
            onChange={(e) => onChange({ desiredName: e.target.value })}
          />
          {fresh?.ignoredName && <p className="mt-1 text-xs text-amber-700">{fresh.ignoredName}</p>}
        </Field>
        <Field label="Name check">
          <Dropdown
            value={toChoice(l.enforceOverride)}
            onChange={(c) => onChange({ enforceOverride: fromChoice(c) })}
            options={ENFORCE_OPTIONS}
          />
        </Field>
      </div>

      <p className="mt-3 text-sm font-medium text-gray-900">{res.line}</p>
      {res.drift && <p className="text-sm text-amber-700">{res.drift}</p>}
      {l.lastRenamedAt && (
        <p className="mt-1 text-xs text-gray-400">
          Last put back: {shortDate(l.lastRenamedAt)}
          {l.lastRenamedFrom ? `, was ‘${l.lastRenamedFrom}’` : ''}
        </p>
      )}
    </Card>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={
        'relative inline-flex h-6 w-11 items-center rounded-full transition ' + (value ? 'bg-red-500' : 'bg-gray-200')
      }
    >
      <span className={'inline-block h-4 w-4 rounded-full bg-white transition ' + (value ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  )
}

/**
 * Расписание — временем, а не cron-строкой: «каждый день / по дню недели» + время.
 * Всё, что не укладывается в эти два вида, редактируется как выражение (Advanced).
 * Подпись про America/New_York обязательна — таймзона живёт в деплое агента, и на
 * экране это единственное место, где человек о ней узнаёт.
 */
function CronControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const shape = parseCron(value)
  const [advanced, setAdvanced] = useState(shape.mode === 'raw')

  const hour = shape.mode === 'raw' ? 9 : shape.hour
  const minute = shape.mode === 'raw' ? 0 : shape.minute
  const weekday = shape.mode === 'weekly' ? shape.weekday : 1
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  function emit(next: { mode: 'daily' | 'weekly'; time?: string; weekday?: number }) {
    const [h, m] = (next.time ?? time).split(':').map(Number)
    onChange(buildCron(
      next.mode === 'weekly'
        ? { mode: 'weekly', hour: h, minute: m, weekday: next.weekday ?? weekday }
        : { mode: 'daily', hour: h, minute: m },
    ))
  }

  return (
    <div>
      {advanced ? (
        <Input className="max-w-xs font-mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0 9 * * *" />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            className="w-40"
            value={shape.mode === 'weekly' ? 'weekly' : 'daily'}
            onChange={(m) => emit({ mode: m as 'daily' | 'weekly' })}
            options={[{ value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'Every week' }]}
          />
          {shape.mode === 'weekly' && (
            <Dropdown
              className="w-40"
              value={String(weekday)}
              onChange={(d) => emit({ mode: 'weekly', weekday: Number(d) })}
              options={WEEKDAYS.map((w) => ({ value: String(w.value), label: w.label }))}
            />
          )}
          <Input
            type="time"
            className="w-32"
            value={time}
            onChange={(e) => emit({ mode: shape.mode === 'weekly' ? 'weekly' : 'daily', time: e.target.value })}
          />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">{describeCron(value)}</span>
        <button type="button" className="text-xs text-gray-400 underline hover:text-gray-700" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? 'Use the simple editor' : 'Advanced (cron)'}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        Entered and read in {GMB_TZ_LABEL} — not your local time.
      </p>
    </div>
  )
}

/** Таблица топиков постов. Регионы — закрытый словарь `gmb."Region"`, свободного текста нет. */
function TopicTable({
  value, onChange, regions,
}: { value: GmbTopic[]; onChange: (v: GmbTopic[]) => void; regions: GmbRegion[] }) {
  function patch(i: number, p: Partial<GmbTopic>) {
    onChange(value.map((t, j) => (j === i ? { ...t, ...p } : t)))
  }
  return (
    <div className="space-y-4">
      {value.map((t, i) => (
        <div key={i} className="rounded-lg border border-gray-200 p-4">
          <div className="mb-3 flex gap-2">
            <Field label="Key" className="w-48">
              <Input value={t.key} onChange={(e) => patch(i, { key: e.target.value })} placeholder="egress-window" />
            </Field>
            <Field label="Label" className="flex-1">
              <Input value={t.label} onChange={(e) => patch(i, { label: e.target.value })} />
            </Field>
            <Button variant="ghost" className="mt-6 h-9 shrink-0 px-2 text-gray-400 hover:text-red-600" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={15} />
            </Button>
          </div>
          <Field label="Query" hint="What retrieves context from the wiki. Max 300 characters." className="mb-3">
            <Textarea rows={2} value={t.query} onChange={(e) => patch(i, { query: e.target.value })} />
          </Field>
          <Field label="Regions" hint="Empty means the topic goes to every listing.">
            <div className="flex flex-wrap gap-2">
              {regions.map((r) => {
                const on = t.regions.includes(r.code)
                return (
                  <label
                    key={r.code}
                    className={
                      'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition ' +
                      (on ? 'border-brand-blue bg-blue-50 text-brand-blue' : 'border-gray-200 text-gray-700 hover:bg-gray-50')
                    }
                  >
                    <input
                      type="checkbox"
                      className="accent-brand-blue"
                      checked={on}
                      onChange={() => patch(i, { regions: on ? t.regions.filter((x) => x !== r.code) : [...t.regions, r.code] })}
                    />
                    {r.label}
                  </label>
                )
              })}
            </div>
          </Field>
        </div>
      ))}
      <Button variant="outline" onClick={() => onChange([...value, { key: '', label: '', query: '', regions: [] }])}>
        <Plus size={14} /> Add topic
      </Button>
    </div>
  )
}
