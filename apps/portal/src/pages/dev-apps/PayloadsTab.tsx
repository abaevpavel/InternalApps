import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Pencil, Trash2 } from 'lucide-react'
import { Button, Card, Input, StatusBadge, Tabs } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { loadSources, saveSource } from '../../services/dev-sources'
import { loadMarks, setMark, type MarkStatus, type MarksIndex } from '../../services/dev-marks'
import targetSpec from '../../data/payload-target.json'

/** Целевая структура из репо (правится по договорённости): scope → delete / add / keep / makeChanges. */
interface SpecScope {
  summary?: string
  decided?: string
  delete?: { path: string; note?: string }[]
  add?: { path: string; type?: string; note?: string }[]
  keep?: { path: string; note?: string }[]
  makeChanges?: string[]
  /** Что доделать в Mac-приложении, чтобы оно слало целевую структуру. */
  appChanges?: string[]
  history?: string[]
}
const SPEC = (targetSpec as { scopes: Record<string, SpecScope> }).scopes

/**
 * Пометки для экрана: сначала целевая структура из репо (метка spec), поверх — пометки из базы
 * (их ставят кнопками на экране, они главнее).
 */
function mergedMarks(scope: string, db: MarksIndex): Map<string, { status: MarkStatus; fieldType: string | null; note: string | null; updatedByName: string | null; updatedAt: string; fromSpec?: boolean }> {
  const out = new Map<string, { status: MarkStatus; fieldType: string | null; note: string | null; updatedByName: string | null; updatedAt: string; fromSpec?: boolean }>()
  const sp = SPEC[scope]
  const put = (path: string, status: MarkStatus, fieldType: string | null, note: string | null) =>
    out.set(path, { status, fieldType, note, updatedByName: 'spec', updatedAt: sp?.decided ?? '', fromSpec: true })
  for (const d of sp?.delete ?? []) put(d.path, 'delete', null, d.note ?? null)
  for (const k of sp?.keep ?? []) put(k.path, 'keep', null, k.note ?? null)
  for (const a of sp?.add ?? []) put(a.path, 'add', a.type ?? null, a.note ?? null)
  for (const [path, m] of db.get(scope) ?? []) out.set(path, m)
  return out
}
import {
  STAGES, buildPayloadTree, filterPayloadTree,
  type AppAction, type PayloadField, type PayloadNode, type CatalogSnapshot, type ScenarioEntry, type SourceKind, type WebhookSource,
} from '../../domain/make-catalog'

/**
 * Payload'ы вебхуков сценариев цепочки (BAS-1504), в двух разрезах:
 *   Mac app       — то, что шлёт estimatingTool, сгруппировано по действиям приложения;
 *   Other external — JotForm, QuickBooks, Retool и прочие, плюс ещё не размеченные.
 * Источник у каждого сценария размечается прямо здесь и хранится в базе (dev_webhook_sources).
 */
type Sub = 'mac' | 'external'
type FieldFilter = 'all' | 'unused' | 'missing' | 'delete' | 'add'

/** scope → путь → сценарии, которые этот путь читают (для предупреждения при пометке «удалить»). */
type Readers = Map<string, Map<string, string[]>>

export function PayloadsTab({ catalog }: { catalog: CatalogSnapshot }) {
  const [sub, setSub] = useState<Sub>('mac')
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all')
  const sourcesQ = useQuery({ queryKey: ['dev-webhook-sources'], queryFn: loadSources })
  const marksQ = useQuery({ queryKey: ['dev-payload-marks'], queryFn: loadMarks })
  const readers = useMemo(() => {
    const out: Readers = new Map()
    for (const s of catalog.scenarios) {
      const scope = s.markScope ?? `scenario:${s.id}`
      if (!out.has(scope)) out.set(scope, new Map())
      for (const f of s.webhook?.fields ?? []) {
        if (!f.usedIn.length) continue
        const m = out.get(scope)!
        m.set(f.path, [...(m.get(f.path) ?? []), s.name.trim()])
      }
    }
    return out
  }, [catalog])

  if (!catalog.generatedAt) {
    return <p className="text-sm text-gray-500">The payload catalogue is empty until the snapshot is built from the Make blueprints.</p>
  }

  // Разметка из базы поверх значения по умолчанию из снимка.
  const sourceOf = (s: ScenarioEntry): WebhookSource => sourcesQ.data?.get(s.id) ?? s.source
  const withHook = catalog.scenarios.filter((s) => s.webhook)
  const mac = withHook.filter((s) => sourceOf(s).kind === 'mac_app')
  const external = withHook.filter((s) => sourceOf(s).kind === 'external')
  const unknown = withHook.filter((s) => sourceOf(s).kind === 'unknown')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          className="max-w-sm"
          tabs={[
            { key: 'mac' as const, label: `Mac app · ${mac.length}` },
            { key: 'external' as const, label: `Other external · ${external.length + unknown.length}` },
          ]}
          value={sub}
          onChange={setSub}
        />
        <div className="ml-auto flex gap-1">
          {(['all', 'unused', 'missing', 'delete', 'add'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFieldFilter(k)}
              className={cn('rounded-full border px-3 py-1 text-xs', fieldFilter === k ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}
            >
              {k === 'all' ? 'All fields' : k === 'unused' ? 'Not read' : k === 'missing' ? 'Missing' : k === 'delete' ? 'Marked delete' : 'To add'}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Known from: <b>structure</b> — in the webhook’s data structure in Make; <b>sent by app</b> — the Mac app sends it (from the
        estimatingTool code); <b>read only</b> — known only because the scenario reads it. <b>not read in Make</b> — arrives but no module
        reads it (directly, through an iterator or variable, toCollection or JS code); if it travels inside an object passed on whole
        (JSON, HTTP), that is shown — only the receiver can use it. A candidate for removal (BAS-1505). <b>missing</b> — the scenario reads it but the Mac app never sends it: a dead reference, a
        typo, or a field added on the way (pdfbuilder / int).
      </p>
      {sub === 'mac' && catalog.appPayloadSource && <p className="text-[11px] text-gray-400">{catalog.appPayloadSource}</p>}
      {sourcesQ.error && <p className="text-sm text-red-600">Sources: {errMsg(sourcesQ.error)}</p>}
      {marksQ.error && <p className="text-sm text-red-600">Marks: {errMsg(marksQ.error)}</p>}

      {sub === 'mac' ? (
        <>
          <ActionMap actions={catalog.appActions ?? []} routes={catalog.appActionRoutes ?? {}} scenarios={catalog.scenarios} />
          <ScenarioList scenarios={mac} sourceOf={sourceOf} filter={fieldFilter} marks={marksQ.data ?? new Map()} readers={readers} />
        </>
      ) : (
        <>
          <ScenarioList scenarios={external} sourceOf={sourceOf} filter={fieldFilter} marks={marksQ.data ?? new Map()} readers={readers} />
          {unknown.length > 0 && (
            <section>
              <h3 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-gray-500">Source not set yet · {unknown.length}</h3>
              <ScenarioList scenarios={unknown} sourceOf={sourceOf} filter={fieldFilter} marks={marksQ.data ?? new Map()} readers={readers} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

/** Действия Mac-приложения → куда их шлёт приложение → какой сценарий принимает (по коду estimatingTool). */
function ActionMap({ actions, routes, scenarios }: { actions: AppAction[]; routes: Record<string, string>; scenarios: ScenarioEntry[] }) {
  // Свёрнутость запоминается в браузере: таблица нужна редко, а места занимает много.
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('dev-apps:action-map-hidden') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setHidden((h) => {
      try {
        localStorage.setItem('dev-apps:action-map-hidden', h ? '0' : '1')
      } catch {
        /* хранилище недоступно — просто не запоминаем */
      }
      return !h
    })
  if (!actions.length) return null
  return (
    <Card className="overflow-x-auto p-0">
      <button type="button" onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50">
        <ChevronDown className={cn('h-4 w-4 transition-transform', hidden && '-rotate-90')} />
        App actions · {actions.length}
        {hidden && <span className="font-normal normal-case tracking-normal text-gray-400">— hidden, click to show</span>}
      </button>
      {!hidden && (
      <table className="w-full border-t border-gray-100 text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
            <th className="px-3 py-2 font-normal">App action</th>
            <th className="px-3 py-2 font-normal">Button</th>
            <th className="px-3 py-2 font-normal">Document</th>
            <th className="px-3 py-2 font-normal">App sends to</th>
            <th className="px-3 py-2 font-normal">Make scenario</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {actions.map((a) => {
            const by = scenarios.filter((s) => (s.appActions ?? []).includes(a.action) || s.actions.includes(a.action))
            return (
              <tr key={a.action}>
                <td className="px-3 py-1.5 font-mono text-xs text-gray-900">{a.action}</td>
                <td className="px-3 py-1.5 text-gray-700">{a.button}</td>
                <td className="px-3 py-1.5 text-gray-500">{a.document}</td>
                <td className="px-3 py-1.5 text-xs text-gray-500">{routes[a.action] ?? '—'}</td>
                <td className="px-3 py-1.5 text-gray-700">
                  {by.length ? by.map((s) => s.name.trim()).join(', ') : <span className="text-gray-400">not matched</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      )}
    </Card>
  )
}

function ScenarioList({
  scenarios, sourceOf, filter, marks, readers,
}: {
  scenarios: ScenarioEntry[]
  sourceOf: (s: ScenarioEntry) => WebhookSource
  filter: FieldFilter
  marks: MarksIndex
  readers: Readers
}) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  const toggle = (id: number) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // От самого маленького payload'а к самому объёмному; при равенстве — по этапу цепочки.
  const size = (s: ScenarioEntry) => s.webhook?.fields.length ?? 0
  const stage = (s: ScenarioEntry) => STAGES.findIndex((x) => x.key === s.stage)
  const sorted = [...scenarios].sort((a, b) => size(a) - size(b) || stage(a) - stage(b))

  if (!sorted.length) return <p className="text-sm text-gray-500">No scenarios here yet.</p>
  return (
    <div className="space-y-2">
      {sorted.map((s) => {
        const scope = s.markScope ?? `scenario:${s.id}`
        const scopeMarks = mergedMarks(scope, marks)
        const fields = (s.webhook?.fields ?? []).filter((f) =>
          filter === 'all' || filter === 'add' || (filter === 'unused' ? f.unused : filter === 'missing' ? f.missing : effectiveMark(f.path, scopeMarks) === 'delete'))
        const unused = (s.webhook?.fields ?? []).filter((f) => f.unused).length
        const missing = (s.webhook?.fields ?? []).filter((f) => f.missing).length
        const src = sourceOf(s)
        const isOpen = open.has(s.id)
        // Дерево — то, что реально приходит. Поля, которые Make читает, а приложение не шлёт
        // (мёртвые ссылки), видны только под фильтром Missing.
        const sentFields = (s.webhook?.fields ?? []).filter((f) => filter === 'missing' || !f.missing)
        return (
          <Card key={s.id} className="overflow-hidden">
            <button type="button" onClick={() => toggle(s.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
              <ChevronDown size={16} className={cn('shrink-0 text-gray-400 transition', !isOpen && '-rotate-90')} />
              <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{s.name}</span>
              <span className="text-xs text-gray-500">{src.sender ?? '—'}</span>
              <span className="text-xs text-gray-500">{s.webhook?.fields.length ?? 0} fields</span>
              {unused > 0 && <StatusBadge tone="pending">{unused} unused</StatusBadge>}
              {missing > 0 && <StatusBadge tone="danger">{missing} missing</StatusBadge>}
            </button>
            {isOpen && (
              <div className="space-y-3 border-t border-gray-100 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    {s.webhook?.name && <span>webhook «{s.webhook.name}»</span>}
                  {s.appPayload && <span>{s.appPayload}</span>}
                  {(s.appActions ?? []).length > 0 && <span>app actions: {(s.appActions ?? []).map((a) => <code key={a} className="mr-1 rounded bg-gray-100 px-1">{a}</code>)}</span>}
                  {s.actions.length > 0 && <span>filters on: {s.actions.map((a) => <code key={a} className="mr-1 rounded bg-gray-100 px-1">{a}</code>)}</span>}
                  <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 hover:text-gray-800">
                    Open in Make <ExternalLink size={12} />
                  </a>
                </div>
                <SourceEditor scenario={s} current={src} />
                {fields.length === 0 && filter !== 'add' ? (
                  <p className="text-sm text-gray-500">{filter === 'all' ? 'No fields known.' : `No ${filter} fields.`}</p>
                ) : (
                  <>
                  {SPEC[scope] && (
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                    <p><b>Target spec</b>{SPEC[scope].decided ? ` · ${SPEC[scope].decided}` : ''} — {SPEC[scope].summary}</p>
                    {(SPEC[scope].history ?? []).map((h) => <p key={h} className="mt-1 text-blue-800/80">{h}</p>)}
                    {(SPEC[scope].appChanges ?? []).length > 0 && (
                      <details className="mt-1" open>
                        <summary className="cursor-pointer font-medium text-blue-900">Changes needed in the Mac app ({SPEC[scope].appChanges!.length})</summary>
                        <ol className="mt-1 list-decimal pl-5">
                          {SPEC[scope].appChanges!.map((c) => <li key={c}>{c}</li>)}
                        </ol>
                      </details>
                    )}
                    {(SPEC[scope].makeChanges ?? []).length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-blue-800">Changes needed in Make ({SPEC[scope].makeChanges!.length})</summary>
                        <ul className="mt-1 list-disc pl-5">
                          {SPEC[scope].makeChanges!.map((c) => <li key={c}>{c}</li>)}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
                <div className="grid gap-3 xl:grid-cols-2">
                    <div className="min-w-0">
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">Current — mark what to delete</p>
                      <PayloadTreeView fields={sentFields} filter={filter} scope={scope} marks={scopeMarks} readers={readers.get(scope) ?? new Map()} />
                    </div>
                    <div className="min-w-0">
                      <TargetView fields={(s.webhook?.fields ?? []).filter((f) => !f.missing)} marks={scopeMarks} scope={scope} />
                    </div>
                  </div>
                  </>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

/* ---------------- дерево полей ---------------- */

/** Помечен ли на удаление кто-то из предков пути (ветка удалена → всё внутри тоже). */
/**
 * Раскрытие веток: у каждой есть «по умолчанию» (например, раскрыта, потому что внутри новые поля
 * или включён фильтр), но клик пользователя всегда главнее — ветку можно и свернуть, и раскрыть.
 */
function useBranchToggle(defaultOpen: (n: PayloadNode) => boolean) {
  const [override, setOverride] = useState<Map<string, boolean>>(new Map())
  const isOpen = (n: PayloadNode) => override.get(n.path) ?? defaultOpen(n)
  const toggle = (n: PayloadNode) =>
    setOverride((cur) => new Map(cur).set(n.path, !isOpen(n)))
  return { isOpen, toggle }
}

/**
 * `a.b[]` и `a.b` — один и тот же узел (массив, помеченный целиком): пометка может лежать под любым
 * из двух путей. markKey — путь, под которым она лежит на самом деле (по нему её и меняем).
 */
function markKey(marks: Map<string, unknown>, path: string): string {
  if (marks.has(path)) return path
  const alt = path.endsWith('[]') ? path.slice(0, -2) : `${path}[]`
  return marks.has(alt) ? alt : path
}

function markAt<T>(marks: Map<string, T>, path: string): T | undefined {
  return marks.get(markKey(marks, path))
}

function ancestorDeleted(path: string, marks: Map<string, { status: MarkStatus }>): boolean {
  const segs = path.split('.')
  for (let i = segs.length - 1; i > 0; i--) {
    if (markAt(marks, segs.slice(0, i).join('.'))?.status === 'delete') return true
  }
  return false
}

/** Пометка пути: своя или унаследованная от ближайшего помеченного предка (ветка → всё внутри). */
function effectiveMark(path: string, marks: Map<string, { status: MarkStatus }>): MarkStatus | null {
  if (markAt(marks, path)) return markAt(marks, path)!.status
  // Наследуются только «удалить» / «оставить»; «добавить» относится к одному полю.
  const segs = path.split('.')
  for (let i = segs.length - 1; i > 0; i--) {
    const st = markAt(marks, segs.slice(0, i).join('.'))?.status
    if (st === 'delete' || st === 'keep') return st
  }
  return null
}

/**
 * Поля payload'а деревом, как в самом JSON: узлы раскрываются и сворачиваются. По умолчанию
 * виден верхний уровень; при фильтре Unused / Missing — только ветки с такими полями, раскрытые.
 */
function PayloadTreeView({
  fields, filter, scope, marks, readers,
}: {
  fields: PayloadField[]
  filter: FieldFilter
  scope: string
  marks: Map<string, { status: MarkStatus; fieldType: string | null; note: string | null; updatedByName: string | null; updatedAt: string; fromSpec?: boolean }>
  readers: Map<string, string[]>
}) {
  const qc = useQueryClient()
  const markM = useMutation({
    mutationFn: (v: { path: string; status: MarkStatus | null; extra?: { fieldType?: string; note?: string } }) =>
      setMark(scope, v.path, v.status, v.extra),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev-payload-marks'] }),
  })
  const [adding, setAdding] = useState<string | null>(null)
  // Строки — в одну линию; клик по полю раскрывает его детали целиком.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleLeaf = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const tree = useMemo(() => {
    // Запланированные поля — рядом с настоящими, на своём месте в дереве.
    const known = new Set(fields.map((f) => f.path))
    const planned: PayloadField[] = []
    for (const [path, m] of marks) {
      if (m.status !== 'add' || known.has(path) || ancestorDeleted(path, marks)) continue
      planned.push({ path, type: m.fieldType, example: null, usedIn: [], origin: 'reference', unused: false, planned: { fieldType: m.fieldType, note: m.note } })
    }
    const t = buildPayloadTree([...fields, ...planned])
    if (filter === 'all') return t
    return filterPayloadTree(t, (f) =>
      filter === 'add' ? !!f.planned
        : filter === 'unused' ? f.unused : filter === 'missing' ? !!f.missing : effectiveMark(f.path, marks) === 'delete')
  }, [fields, filter, marks])
  // Кто из сценариев этого payload'а читает путь или что-то внутри него.
  const readersOf = (path: string) => {
    const names = new Set<string>()
    for (const [p, who] of readers) {
      if (p === path || p.startsWith(path + '.') || p.startsWith(path + '[].')) who.forEach((w) => names.add(w))
    }
    return [...names]
  }
  // С фильтром дерево раскрыто целиком, чтобы найденное было видно; свернуть всё равно можно.
  const allOpen = filter !== 'all'
  const branches = useBranchToggle(() => allOpen)

  const rows: { node: PayloadNode; depth: number }[] = []
  const walk = (nodes: PayloadNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth })
      if (n.children.length && branches.isOpen(n)) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)

  return (
    <div className="rounded-lg border border-gray-100 text-xs">
      <div className="flex items-center gap-2 border-b border-gray-100 px-2 py-1">
        <button type="button" className="text-[11px] text-green-700 hover:underline" onClick={() => setAdding(adding === '' ? null : '')}>
          + Add field at the top level
        </button>
      </div>
      {adding === '' && <AddFieldForm parent="" onCancel={() => setAdding(null)} onSave={(v) => markM.mutateAsync(v).then(() => setAdding(null))} />}
      {rows.flatMap(({ node: n, depth }) => {
        const row = renderRow(n, depth)
        return adding === n.path
          ? [row, <AddFieldForm key={`${n.path}#add`} parent={n.path} depth={depth + 1} onCancel={() => setAdding(null)} onSave={(v) => markM.mutateAsync(v).then(() => setAdding(null))} />]
          : [row]
      })}
    </div>
  )

  function renderRow(n: PayloadNode, depth: number) {
        const branch = n.children.length > 0
        const isOpen = branches.isOpen(n)
        const f = n.field
        const key = markKey(marks, n.path)
        const own = marks.get(key)?.status ?? null
        const fromSpec = !!marks.get(key)?.fromSpec
        const eff = effectiveMark(n.path, marks)
        const planned = f?.planned
        const deleted = eff === 'delete'
        const conflict = deleted ? readersOf(n.path) : []
        return (
          <div
            key={n.path}
            className={cn(
              'group flex gap-2 border-b border-gray-50 py-1 pr-2 last:border-0',
              expanded.has(n.path) ? 'items-start' : 'items-center',
              'cursor-pointer hover:bg-gray-50',
              deleted && 'bg-red-50 hover:bg-red-100',
              planned && 'bg-green-50 hover:bg-green-100',
            )}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => (branch ? branches.toggle(n) : toggleLeaf(n.path))}
          >
            <span className="w-3 shrink-0 text-gray-400">
              {branch && <ChevronDown size={12} className={cn('transition', !isOpen && '-rotate-90')} />}
            </span>
            <span
              className={cn(
                'shrink-0 font-mono',
                branch ? 'font-medium text-gray-900' : 'text-gray-800',
                deleted && 'text-red-700 line-through',
                eff === 'keep' && 'text-green-800',
                planned && 'font-semibold text-green-800',
              )}
            >
              {n.key}
            </span>
            {planned && (
              <span className={cn('flex min-w-0 flex-1 items-center gap-1.5', expanded.has(n.path) ? 'flex-wrap' : 'overflow-hidden')}>
                <span className="shrink-0 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">new</span>
                {planned.fieldType && <span className="shrink-0 text-green-800">{planned.fieldType}</span>}
                {planned.note && <span className={cn('text-gray-600', !expanded.has(n.path) && 'truncate')}>{planned.note}</span>}
              </span>
            )}
            {branch ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-gray-400">
                <span>{n.leaves} fields</span>
                {n.unused > 0 && <StatusBadge tone="pending">{n.unused} unused</StatusBadge>}
                {n.missing > 0 && <StatusBadge tone="danger">{n.missing} missing</StatusBadge>}
                {f && f.usedIn.length > 0 && <span className="truncate text-gray-500">· used as a whole: {f.usedIn[0].where}</span>}
              </span>
            ) : (
              f && !planned && <FieldCells field={f} expanded={expanded.has(n.path)} />
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1 pl-2" onClick={(e) => e.stopPropagation()}>
              {conflict.length > 0 && (
                <span className={cn('text-[11px] text-red-700', !expanded.has(n.path) && 'max-w-[14rem] truncate')} title={conflict.join(', ')}>
                  ⚠ read in: {conflict.join(', ')}
                </span>
              )}
              {eff && !own && <span className="text-[10px] text-gray-400">{eff === 'delete' ? 'deleted with parent' : 'kept with parent'}</span>}
              {fromSpec && <span className="rounded bg-blue-50 px-1 text-[10px] text-blue-700" title="From the target spec in the repo">spec</span>}
              {own && own !== 'add' && marks.get(key)?.note && (
                <span className={cn('text-[11px] text-gray-600', !expanded.has(n.path) && 'max-w-[18rem] truncate')} title={marks.get(key)!.note!}>{marks.get(key)!.note}</span>
              )}
              {own && own !== 'add' && (
                <span
                  className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', own === 'delete' ? 'bg-red-600 text-white' : 'bg-green-100 text-green-800')}
                  title={marks.get(key)?.updatedByName ? `Marked by ${marks.get(key)!.updatedByName}` : undefined}
                >
                  {own}
                </span>
              )}
              <span className="hidden gap-1 group-hover:flex">
                {(branch || planned) && (
                  <button type="button" className="rounded border border-green-300 px-1.5 text-[10px] text-green-800 hover:bg-green-100" onClick={() => setAdding(n.path)}>
                    + Add field
                  </button>
                )}
                {!planned && own !== 'delete' && (
                  <button type="button" className="rounded border border-red-200 px-1.5 text-[10px] text-red-700 hover:bg-red-100" onClick={() => markM.mutate({ path: key, status: 'delete' })}>
                    Delete
                  </button>
                )}
                {!planned && own !== 'keep' && (
                  <button type="button" className="rounded border border-green-200 px-1.5 text-[10px] text-green-800 hover:bg-green-100" onClick={() => markM.mutate({ path: key, status: 'keep' })}>
                    Keep
                  </button>
                )}
                {own && !fromSpec && (
                  <button type="button" className="rounded border border-gray-200 px-1.5 text-[10px] text-gray-600 hover:bg-gray-100" onClick={() => markM.mutate({ path: key, status: null })}>
                    {planned ? 'Remove' : 'Clear'}
                  </button>
                )}
              </span>
            </span>
          </div>
        )
  }
}

/**
 * Целевой payload — каким он должен стать: без помеченного на удаление (своё или от родителя),
 * с запланированными полями на своих местах (зелёные, «+»). Только чтение, дерево раскрывается.
 */
function TargetView({
  fields, marks, scope,
}: {
  fields: PayloadField[]
  marks: Map<string, { status: MarkStatus; fieldType: string | null; note: string | null; fromSpec?: boolean }>
  scope: string
}) {
  const qc = useQueryClient()
  /**
   * Удалить из целевой структуры — начисто, без пометки в Target:
   *  • новое поле из базы — просто снимаем «add»;
   *  • новое поле из спеки (репо) или существующее поле / ветка — ставим «delete»: для спеки это
   *    отмена добавления, для существующего — оно уходит из Target (слева остаётся красным).
   */
  const removeM = useMutation({
    mutationFn: (v: { path: string; planned: boolean; fromSpec: boolean }) =>
      v.planned && !v.fromSpec ? setMark(scope, v.path, null) : setMark(scope, v.path, 'delete'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev-payload-marks'] }),
  })
  const { tree, current, removed, added } = useMemo(() => {
    const known = new Set(fields.map((f) => f.path))
    const kept = fields.filter((f) => effectiveMark(f.path, marks) !== 'delete')
    const planned: PayloadField[] = []
    for (const [path, m] of marks) {
      if (m.status !== 'add' || known.has(path) || ancestorDeleted(path, marks)) continue
      planned.push({ path, type: m.fieldType, example: null, usedIn: [], origin: 'reference', unused: false, planned: { fieldType: m.fieldType, note: m.note } })
    }
    const leaves = (fs: PayloadField[]) => buildPayloadTree(fs).reduce((n, x) => n + x.leaves, 0)
    // Новые блоки (люди, projectInfo) — наверху: в длинных payload'ах (Submit sale — 60 полей в корне)
    // они иначе теряются в самом низу списка.
    const withNew = (n: PayloadNode): boolean => !!n.field?.planned || n.children.some(withNew)
    const tree = buildPayloadTree([...kept, ...planned])
    tree.sort((a, b) => Number(withNew(b)) - Number(withNew(a)))
    return {
      tree,
      current: leaves(fields),
      removed: leaves(fields) - leaves(kept),
      added: planned.length,
    }
  }, [fields, marks])
  // Ветка с новыми полями внутри по умолчанию раскрыта — их сразу видно; клик её сворачивает.
  const hasNew = (n: PayloadNode): boolean => !!n.field?.planned || n.children.some(hasNew)
  const branches = useBranchToggle(hasNew)

  const rows: { n: PayloadNode; depth: number }[] = []
  const walk = (nodes: PayloadNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ n, depth })
      if (n.children.length && branches.isOpen(n)) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)

  return (
    <div>
      <p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
        Target — how it should be
        <span className="normal-case tracking-normal text-gray-500">
          {current} → <b className="text-gray-900">{current - removed + added}</b> fields
          {removed > 0 && <span className="text-red-600"> · −{removed}</span>}
          {added > 0 && <span className="text-green-700"> · +{added}</span>}
        </span>
      </p>
      <div className="rounded-lg border border-gray-100 font-mono text-xs">
        {rows.map(({ n, depth }) => {
          const branch = n.children.length > 0
          const planned = n.field?.planned
          const isOpen = branches.isOpen(n)
          return (
            <div
              key={n.path}
              className={cn('group flex items-baseline gap-2 border-b border-gray-50 py-0.5 pr-2 last:border-0', branch && 'cursor-pointer hover:bg-gray-50', planned && 'bg-green-50')}
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={branch ? () => branches.toggle(n) : undefined}
            >
              <span className="w-3 shrink-0 text-gray-400">
                {branch ? <ChevronDown size={12} className={cn('inline transition', !isOpen && '-rotate-90')} /> : planned ? <span className="text-green-700">+</span> : null}
              </span>
              <span className={cn(branch ? 'font-medium text-gray-900' : 'text-gray-800', planned && 'font-semibold text-green-800')}>{n.key}</span>
              {branch ? (
                <span className="font-sans text-gray-400">{n.leaves} fields</span>
              ) : (
                <span className={cn('min-w-0 truncate font-sans', planned ? 'text-green-700' : 'text-gray-400')}>
                  {n.field?.type ?? planned?.fieldType ?? ''}
                  {planned?.note && <span className="ml-2 text-gray-500">{planned.note}</span>}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${n.path} from the target`}
                title="Remove from the target"
                className="ml-auto hidden shrink-0 text-gray-400 hover:text-red-600 group-hover:block"
                disabled={removeM.isPending}
                onClick={(e) => {
                  e.stopPropagation()
                  removeM.mutate({ path: markKey(marks, n.path), planned: !!planned, fromSpec: !!markAt(marks, n.path)?.fromSpec })
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Новое поле: имя (можно с точками — вложенный путь), тип, заметка. Путь строится от ветки. */
function AddFieldForm({
  parent, depth = 0, onSave, onCancel,
}: {
  parent: string
  depth?: number
  onSave: (v: { path: string; status: MarkStatus; extra: { fieldType: string; note: string } }) => Promise<unknown>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const clean = name.trim().replace(/^\.+|\.+$/g, '')
  const path = parent ? `${parent}.${clean}` : clean
  async function save() {
    if (!clean) return
    setBusy(true)
    try {
      await onSave({ path, status: 'add', extra: { fieldType: type, note } })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-green-100 bg-green-50 py-1.5 pr-2" style={{ paddingLeft: 8 + depth * 16 + 20 }}>
      <span className="font-mono text-[11px] text-green-800">{parent ? `${parent}.` : ''}</span>
      <Input autoFocus className="h-7 w-40 py-0.5 font-mono text-xs" placeholder="fieldName" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <Input className="h-7 w-28 py-0.5 text-xs" placeholder="type (text…)" value={type} onChange={(e) => setType(e.target.value)} />
      <Input className="h-7 min-w-[10rem] flex-1 py-0.5 text-xs" placeholder="note — why / where from" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <Button variant="primary" className="h-7 px-2 text-[11px]" disabled={!clean || busy} onClick={save}>Add</Button>
      <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={onCancel}>Cancel</Button>
    </div>
  )
}

function FieldCells({ field: f, expanded }: { field: PayloadField; expanded: boolean }) {
  const origin = (
    <span
      className={cn(
        'shrink-0 whitespace-nowrap rounded px-1.5 py-0.5',
        f.origin === 'structure' ? 'bg-gray-100 text-gray-600' : f.origin === 'app' ? 'bg-blue-50 text-blue-700' : 'bg-violet-50 text-violet-700',
      )}
    >
      {f.origin === 'structure' ? 'structure' : f.origin === 'app' ? 'sent by app' : 'read only'}
    </span>
  )
  const uses = f.usedIn.map((u) => `#${u.moduleId} ${u.where}`)
  const fwd = (f.forwardedTo ?? []).map((u) => `#${u.moduleId} ${u.where}`)
  const more = (n: number) => (n > 1 ? <span className="shrink-0 text-gray-400">+{n - 1}</span> : null)
  return (
    <span className={cn('flex min-w-0 flex-1 items-center gap-1.5', expanded ? 'flex-wrap' : 'overflow-hidden whitespace-nowrap')}>
      {f.type && <span className="shrink-0 text-gray-400">{f.type}</span>}
      {origin}
      {f.missing && <StatusBadge tone="danger" className="shrink-0">missing</StatusBadge>}
      {f.addedBy && <span className="shrink-0 whitespace-nowrap rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" title="Not sent by the app — added on the way">added by {f.addedBy}</span>}
      {f.unused ? (
        <>
          <StatusBadge tone="pending" className="shrink-0">not read in Make</StatusBadge>
          {fwd.length > 0 &&
            (expanded ? (
              <span className="text-gray-400">forwarded whole: {fwd.join('; ')}</span>
            ) : (
              <>
                <span className="min-w-0 truncate text-gray-400">forwarded whole: {fwd[0]}</span>
                {more(fwd.length)}
              </>
            ))}
        </>
      ) : expanded ? (
        <span className="min-w-0 text-gray-600 [overflow-wrap:anywhere]">
          {uses.map((u, i) => (
            <span key={i} className="mr-3 inline-block">{u}</span>
          ))}
        </span>
      ) : (
        <>
          <span className="min-w-0 truncate text-gray-600">{uses[0]}</span>
          {more(uses.length)}
        </>
      )}
    </span>
  )
}

const KINDS: { key: SourceKind; label: string }[] = [
  { key: 'mac_app', label: 'Mac app' },
  { key: 'external', label: 'External' },
  { key: 'unknown', label: 'Not set' },
]

/**
 * Кто шлёт вебхук: одна строка «Sender: …», по клику — маленькое окно с полем, выбором, куда
 * отнести (от этого зависит подраздел), и Save. Хранится в dev_webhook_sources.
 */
function SourceEditor({ scenario, current }: { scenario: ScenarioEntry; current: WebhookSource }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<SourceKind>(current.kind)
  const [sender, setSender] = useState(current.sender ?? '')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveM = useMutation({
    mutationFn: () => saveSource(scenario.id, { kind, sender, note: current.note ?? '' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dev-webhook-sources'] })
      setOpen(false)
    },
  })

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => {
          setKind(current.kind)
          setSender(current.sender ?? '')
          setOpen((v) => !v)
        }}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
        title={current.updatedAt ? `Set by ${current.updatedByName ?? 'someone'} · ${new Date(current.updatedAt).toLocaleString('en-US')}` : 'Default from the snapshot — not saved yet'}
      >
        Sender: <b className="font-medium text-gray-900">{current.sender ?? 'not set'}</b>
        <Pencil size={11} className="text-gray-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              className="h-8 flex-1 py-1 text-sm"
              placeholder="JotForm, QuickBooks, Retool AP AR…"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveM.mutate()
              }}
            />
            <select
              className="h-8 rounded-lg border border-gray-200 bg-white px-1.5 text-xs text-gray-700"
              value={kind}
              onChange={(e) => setKind(e.target.value as SourceKind)}
              aria-label="Source type"
            >
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
            </select>
            <Button variant="primary" className="h-8 px-3 text-xs" disabled={saveM.isPending} onClick={() => saveM.mutate()}>
              {saveM.isPending ? '…' : 'Save'}
            </Button>
          </div>
          {saveM.error && <p className="mt-1 text-xs text-red-600">{errMsg(saveM.error)}</p>}
        </div>
      )}
    </div>
  )
}
