import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Send } from 'lucide-react'
import { Button, Card, StatusBadge, Textarea } from '../../components/ui'
import { cn, errMsg } from '../../lib/utils'
import { useDebouncedCallback } from '../../lib/useDebouncedCallback'
import {
  getAssignedTemplateId,
  getProject,
  getTemplate,
  listItems,
  listProgress,
  sendChecklistToMake,
  upsertProgress,
} from '../../services/production-checklist'
import {
  DEFAULT_ANSWERS,
  buildTree,
  collectLeaves,
  isCompletedStatus,
  type ChecklistItem,
  type ItemNode,
  type ProgressRow,
} from '../../domain/production-checklist'

/** Локальное состояние ответа (подмножество ProgressRow, чем оперирует UI). */
interface Answer {
  selected_answer: string | null
  is_not_applicable: boolean
  notes: string | null
}

interface Block {
  block: ItemNode
  questions: ItemNode[]
}

function buildBlocks(items: ChecklistItem[]): Block[] {
  const roots = buildTree(items)
  return roots.map((root) => ({ block: root, questions: collectLeaves(root) }))
}

export function ProjectChecklistPage() {
  const { projectId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: () => getProject(projectId) })
  const templateIdQ = useQuery({
    queryKey: ['assigned-template', projectId],
    queryFn: () => getAssignedTemplateId(projectId),
  })
  const templateId = templateIdQ.data ?? null
  const templateQ = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => getTemplate(templateId!),
    enabled: !!templateId,
  })
  const itemsQ = useQuery({
    queryKey: ['items', templateId],
    queryFn: () => listItems(templateId!),
    enabled: !!templateId,
  })
  const progressQ = useQuery({ queryKey: ['progress', projectId], queryFn: () => listProgress(projectId) })

  const readOnly = isCompletedStatus(projectQ.data?.status)

  // локальная карта ответов task_id → Answer (сид из БД, обновляется оптимистично)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  useEffect(() => {
    if (!progressQ.data) return
    const map: Record<string, Answer> = {}
    for (const p of progressQ.data) {
      map[p.task_id] = {
        selected_answer: p.selected_answer,
        is_not_applicable: !!p.is_not_applicable,
        notes: p.notes,
      }
    }
    setAnswers(map)
  }, [progressQ.data])

  const blocks = useMemo(() => buildBlocks(itemsQ.data ?? []), [itemsQ.data])

  const allLeaves = useMemo(() => blocks.flatMap((b) => b.questions), [blocks])
  const answeredCount = allLeaves.filter((q) => isAnsweredLocal(answers[q.task_id])).length
  const total = allLeaves.length
  const percent = total ? Math.round((answeredCount / total) * 100) : 0

  const saveAnswer = useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: Partial<ProgressRow> }) =>
      upsertProgress(projectId, taskId, patch),
  })

  function answer(q: ItemNode, option: string) {
    if (readOnly) return
    const isNa = option.trim().toLowerCase() === 'n/a'
    setAnswers((prev) => ({
      ...prev,
      [q.task_id]: { ...prev[q.task_id], selected_answer: option, is_not_applicable: isNa },
    }))
    saveAnswer.mutate({
      taskId: q.task_id,
      patch: {
        selected_answer: option,
        is_not_applicable: isNa,
        completed: true,
        completed_at: new Date().toISOString(),
      },
    })
  }

  const debouncedNotes = useDebouncedCallback((taskId: string, notes: string) => {
    saveAnswer.mutate({ taskId, patch: { notes } })
  }, 600)

  function setNotes(blockTaskId: string, notes: string) {
    if (readOnly) return
    setAnswers((prev) => ({ ...prev, [blockTaskId]: { ...prev[blockTaskId], notes } }))
    debouncedNotes(blockTaskId, notes)
  }

  const sendM = useMutation({
    mutationFn: async () => {
      const project = projectQ.data!
      await sendChecklistToMake({
        project,
        template: templateQ.data ?? null,
        items: itemsQ.data ?? [],
        progress: progressQ.data ?? [],
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  if (projectQ.isLoading) return <Centered>Loading…</Centered>
  if (projectQ.error) return <Centered className="text-red-600">{errMsg(projectQ.error)}</Centered>
  if (!projectQ.data) return <Centered className="text-gray-400">Project not found.</Centered>

  const project = projectQ.data

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <button onClick={() => nav('/production-checklist')} className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft size={16} /> Back to projects
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold text-gray-900">{project.name}</h1>
        <StatusBadge tone={readOnly ? 'success' : 'pending'}>{project.status ?? 'In Progress'}</StatusBadge>
      </div>
      {templateQ.data && (
        <div className="mt-1 text-sm font-medium uppercase tracking-wide text-gray-500">{templateQ.data.name}</div>
      )}

      {!templateId && !templateIdQ.isLoading && (
        <Card className="mt-6 px-6 py-8 text-center text-sm text-gray-400">
          No checklist template assigned to this project yet. Assign one on the Projects tab.
        </Card>
      )}

      {templateId && (
        <>
          {/* прогресс */}
          <div className="mt-6">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-gray-500">
                {answeredCount} / {total} answered
              </span>
              <span className="font-semibold text-gray-700">{percent}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>

          {/* блоки */}
          <div className="mt-6 space-y-4">
            {blocks.map((b) => (
              <BlockCard
                key={b.block.id}
                block={b}
                answers={answers}
                readOnly={readOnly}
                onAnswer={answer}
                onNotes={setNotes}
              />
            ))}
          </div>

          {/* Send */}
          {!readOnly && (
            <div className="mt-8 flex items-center justify-end gap-3">
              {percent < 100 && <span className="text-sm text-gray-400">Answer all items to send.</span>}
              <Button
                variant="green"
                disabled={percent < 100 || sendM.isPending}
                onClick={() => sendM.mutate()}
                title={percent < 100 ? 'Complete the checklist first' : undefined}
              >
                <Send size={16} /> {sendM.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          )}
          {readOnly && project.checklist_sent_at && (
            <div className="mt-8 flex items-center justify-end gap-2 text-sm text-green-700">
              <Check size={16} /> Sent {new Date(project.checklist_sent_at).toLocaleString()}
            </div>
          )}
          {sendM.error && <p className="mt-2 text-right text-sm text-red-600">{errMsg(sendM.error)}</p>}
        </>
      )}
    </div>
  )
}

/* ======================= Block ======================= */

function BlockCard({
  block,
  answers,
  readOnly,
  onAnswer,
  onNotes,
}: {
  block: Block
  answers: Record<string, Answer>
  readOnly: boolean
  onAnswer: (q: ItemNode, option: string) => void
  onNotes: (blockTaskId: string, notes: string) => void
}) {
  const answeredInBlock = block.questions.filter((q) => isAnsweredLocal(answers[q.task_id])).length
  const done = answeredInBlock === block.questions.length && block.questions.length > 0

  // авто-сворачивание завершённых блоков, раскрытие незавершённых
  const [open, setOpen] = useState(!done)
  useEffect(() => {
    setOpen(!done)
  }, [done])

  const notes = answers[block.block.task_id]?.notes ?? ''

  return (
    <Card className={cn('overflow-hidden', done && 'border-green-200')}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-5 py-4 text-left',
          done ? 'bg-green-50/60' : 'bg-white',
        )}
      >
        <span className="flex items-center gap-3">
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-white',
              done ? 'bg-green-500' : 'bg-gray-300',
            )}
          >
            {done ? <Check size={16} /> : <span className="text-xs font-bold">{answeredInBlock}</span>}
          </span>
          <span className={cn('font-semibold', done ? 'text-green-700' : 'text-gray-900')}>{block.block.label}</span>
        </span>
        <span className="flex items-center gap-2 text-sm text-gray-400">
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs">
            {answeredInBlock}/{block.questions.length}
          </span>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {block.questions.map((q) => (
            <Question key={q.id} q={q} answer={answers[q.task_id]} readOnly={readOnly} onAnswer={onAnswer} />
          ))}

          <div className="border-t border-gray-100 px-5 py-4">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">Notes</label>
            <Textarea
              rows={2}
              value={notes}
              disabled={readOnly}
              placeholder="Notes for this block…"
              onChange={(e) => onNotes(block.block.task_id, e.target.value)}
            />
          </div>
        </div>
      )}
    </Card>
  )
}

function Question({
  q,
  answer,
  readOnly,
  onAnswer,
}: {
  q: ItemNode
  answer: Answer | undefined
  readOnly: boolean
  onAnswer: (q: ItemNode, option: string) => void
}) {
  const options = q.answer_options?.length ? q.answer_options : [...DEFAULT_ANSWERS]
  const selected = answer?.is_not_applicable ? 'N/A' : answer?.selected_answer ?? null

  return (
    <div className="px-5 py-4">
      <div className="mb-2 text-sm text-gray-800">{q.label}</div>
      {q.description && <div className="mb-2 text-xs text-gray-500">{q.description}</div>}
      <div className="flex flex-wrap gap-2">
        {options.map((opt, i) => {
          const isSel = selected === opt
          return (
            <button
              key={opt}
              disabled={readOnly}
              onClick={() => onAnswer(q, opt)}
              className={cn(
                'min-w-[64px] rounded-lg border px-4 py-1.5 text-sm font-medium transition disabled:opacity-60',
                isSel ? answerTone(i, true) : answerTone(i, false),
              )}
            >
              {opt}
            </button>
          )
        })}
      </div>
      {q.links && q.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {q.links.map((l, i) => (
            <a key={i} href={l.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
              {l.label || l.url}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** Цвета Y/N/NA: 0=зелёная, 1=красная, остальные=серые. */
function answerTone(i: number, selected: boolean): string {
  if (selected) {
    if (i === 0) return 'border-green-500 bg-green-500 text-white'
    if (i === 1) return 'border-red-500 bg-red-500 text-white'
    return 'border-gray-500 bg-gray-500 text-white'
  }
  return 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
}

/* ======================= helpers ======================= */

function isAnsweredLocal(a: Answer | undefined): boolean {
  if (!a) return false
  return !!a.selected_answer || !!a.is_not_applicable
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('py-20 text-center', className)}>{children}</div>
}
