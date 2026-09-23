import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, MessageSquare, Trash2 } from 'lucide-react'
import { Button, Card, Input, Modal, StatusBadge, Textarea } from '../../components/ui'
import { useAuth } from '../../auth/AuthProvider'
import { usePendingActions } from '../../app/PendingActions'
import { cn, errMsg } from '../../lib/utils'
import { addComment, deleteComment, loadComments } from '../../services/dev-comments'
import {
  MODULE_KINDS, STAGES, makeVariables, previewHtml,
  type CatalogSnapshot, type EmailEntry, type ScenarioComment, type ScenarioEntry, type StageKey,
} from '../../domain/make-catalog'

/**
 * Все письма сценариев Make цепочки продаж (BAS-1556).
 *
 * Список сценариев свёрнут; клик раскрывает модули, которые отправляют письма; клик по модулю —
 * модалка со всеми настройками (от кого, кому, тема, условие, тело). Под модулями — комментарии
 * разработчиков к сценарию (в базе, переживают пересборку снимка).
 */
export function EmailsTab({ catalog }: { catalog: CatalogSnapshot }) {
  const [stage, setStage] = useState<StageKey | 'all'>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [shown, setShown] = useState<{ scenario: ScenarioEntry; email: EmailEntry } | null>(null)
  const commentsQ = useQuery({ queryKey: ['dev-scenario-comments'], queryFn: loadComments })

  const needle = search.trim().toLowerCase()
  const hit = (s: ScenarioEntry) =>
    !needle ||
    s.name.toLowerCase().includes(needle) ||
    s.emails.some((e) =>
      [e.label ?? '', e.subject, e.from ?? '', ...e.to, ...e.cc, ...e.bcc].some((x) => x.toLowerCase().includes(needle)),
    )

  const groups = useMemo(
    () =>
      STAGES.filter((st) => stage === 'all' || st.key === stage)
        .map((st) => ({ stage: st, scenarios: catalog.scenarios.filter((s) => s.stage === st.key && hit(s)) }))
        .filter((g) => g.scenarios.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, stage, needle],
  )

  if (!catalog.generatedAt) {
    return <p className="text-sm text-gray-500">The email catalogue is empty until the snapshot is built from the Make blueprints.</p>
  }

  const total = catalog.scenarios.reduce((n, s) => n + s.emails.length, 0)
  const toggle = (id: number) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StageChip active={stage === 'all'} onClick={() => setStage('all')}>
          All · {catalog.scenarios.length} scenarios · {total} emails
        </StageChip>
        {STAGES.map((st) => {
          const n = catalog.scenarios.filter((s) => s.stage === st.key).length
          return n ? (
            <StageChip key={st.key} active={stage === st.key} onClick={() => setStage(st.key)}>
              {st.label} · {n}
            </StageChip>
          ) : null
        })}
        <Input className="ml-auto max-w-xs" placeholder="Search scenario, subject, recipient" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {commentsQ.error && <p className="text-sm text-red-600">Comments: {errMsg(commentsQ.error)}</p>}
      {groups.length === 0 && <p className="text-sm text-gray-500">Nothing matches.</p>}

      {groups.map((g) => (
        <section key={g.stage.key}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{g.stage.label}</h2>
          <div className="space-y-2">
            {g.scenarios.map((s) => {
              const comments = (commentsQ.data ?? []).filter((c) => c.scenarioId === s.id)
              const isOpen = open.has(s.id)
              return (
                <Card key={s.id} className="overflow-hidden">
                  <button type="button" onClick={() => toggle(s.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
                    <ChevronDown size={16} className={cn('shrink-0 text-gray-400 transition', !isOpen && '-rotate-90')} />
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{s.name}</span>
                    {!s.active && <StatusBadge tone="neutral">off</StatusBadge>}
                    <span className="shrink-0 text-xs text-gray-500">
                      {s.emails.length} {s.emails.length === 1 ? 'email' : 'emails'}
                    </span>
                    {comments.length > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-gray-500">
                        <MessageSquare size={12} /> {comments.length}
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="border-t border-gray-100 px-4 py-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className="font-mono">#{s.id}</span>
                        {s.webhook?.name && <span>webhook «{s.webhook.name}»</span>}
                        <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 hover:text-gray-800">
                          Open in Make <ExternalLink size={12} />
                        </a>
                      </div>
                      {s.emails.length === 0 ? (
                        <p className="py-1 text-sm text-gray-500">No email modules — this scenario hands off to other services or scenarios over HTTP.</p>
                      ) : (
                        <div className="divide-y divide-gray-100">
                          {s.emails.map((e) => (
                            <button
                              key={e.moduleId}
                              type="button"
                              onClick={() => setShown({ scenario: s, email: e })}
                              className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <span className="font-medium text-gray-900">{e.label ?? MODULE_KINDS[e.module] ?? e.module}</span>
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{MODULE_KINDS[e.module] ?? e.module}</span>
                              <span className="min-w-0 flex-1 truncate text-xs text-gray-500">→ {e.to.join(', ') || '—'}</span>
                              <span className="font-mono text-[11px] text-gray-400">#{e.moduleId}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <Comments scenarioId={s.id} comments={comments} />
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        </section>
      ))}

      {shown && <EmailModal scenario={shown.scenario} email={shown.email} onClose={() => setShown(null)} />}
    </div>
  )
}

function StageChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded-full border px-3 py-1 text-xs', active ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}
    >
      {children}
    </button>
  )
}

/* ---------------- модалка модуля ---------------- */

function EmailModal({ scenario, email: e, onClose }: { scenario: ScenarioEntry; email: EmailEntry; onClose: () => void }) {
  const vars = makeVariables(`${e.subject} ${e.bodyHtml} ${e.to.join(' ')} ${e.cc.join(' ')} ${e.from ?? ''}`)
  return (
    <Modal
      open
      size="xl"
      title={e.label ?? MODULE_KINDS[e.module] ?? e.module}
      subtitle={`${scenario.name} · module #${e.moduleId} · ${MODULE_KINDS[e.module] ?? e.module}`}
      onClose={onClose}
      footer={
        <>
          <a href={scenario.url} target="_blank" rel="noreferrer" className="mr-auto inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
            Open scenario in Make <ExternalLink size={13} />
          </a>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[100px_minmax(0,1fr)]">
          <Row label="Sent when" value={e.condition ?? 'Always, whenever the scenario reaches this module'} />
          <Row label="From" value={e.from} />
          <Row label="To" value={e.to.join(', ')} />
          <Row label="CC" value={e.cc.join(', ')} />
          <Row label="BCC" value={e.bcc.join(', ')} />
          <Row label="Reply-to" value={e.replyTo} />
          <Row label="Subject" value={e.subject} />
          <Row label="Attached" value={e.attachments.join(', ')} />
        </dl>
        {vars.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-gray-400">Make variables used</p>
            <div className="flex flex-wrap gap-1">
              {vars.map((v) => (
                <code key={v} className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-900">{v}</code>
              ))}
            </div>
          </div>
        )}
        <div>
          <p className="mb-1 text-xs text-gray-400">Body</p>
          {/* sandbox без разрешений: HTML письма не может выполнить скрипт или уйти по ссылке. */}
          <iframe title={`Email ${e.moduleId}`} sandbox="" srcDoc={previewHtml(e.bodyHtml)} className="h-[26rem] w-full rounded-lg border border-gray-200 bg-white" />
        </div>
      </div>
    </Modal>
  )
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd className="whitespace-pre-wrap text-gray-900 [overflow-wrap:anywhere]">{value}</dd>
    </>
  )
}

/* ---------------- комментарии ---------------- */

function Comments({ scenarioId, comments }: { scenarioId: number; comments: ScenarioComment[] }) {
  const qc = useQueryClient()
  const { effectiveUserId, isAdmin } = useAuth()
  const { confirmAndSchedule } = usePendingActions()
  const [text, setText] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['dev-scenario-comments'] })

  const addM = useMutation({
    mutationFn: () => addComment(scenarioId, text),
    onSuccess: async () => {
      setText('')
      await refresh()
    },
  })

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs font-medium text-gray-500">Comments</p>
      <div className="space-y-2">
        {comments.map((c) => (
          <div key={c.id} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
            <div className="mb-0.5 flex items-center gap-2 text-xs text-gray-400">
              <span className="font-medium text-gray-600">{c.createdByName ?? 'Someone'}</span>
              <span>{new Date(c.createdAt).toLocaleString('en-US')}</span>
              {(c.createdBy === effectiveUserId || isAdmin) && (
                <button
                  type="button"
                  aria-label="Delete comment"
                  className="ml-auto text-gray-400 hover:text-red-600"
                  onClick={() =>
                    void confirmAndSchedule(
                      { title: 'Delete this comment?', body: c.body.slice(0, 200), cta: 'Delete', danger: true },
                      {
                        label: 'Deleting the comment',
                        run: async () => {
                          await deleteComment(c.id)
                          await refresh()
                        },
                      },
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-gray-800">{c.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <Textarea rows={2} className="text-sm" placeholder="Add a comment about this scenario…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button variant="primary" className="h-9 shrink-0" disabled={!text.trim() || addM.isPending} onClick={() => addM.mutate()}>
          {addM.isPending ? 'Saving…' : 'Comment'}
        </Button>
      </div>
      {addM.error && <p className="mt-1 text-xs text-red-600">{errMsg(addM.error)}</p>}
    </div>
  )
}
