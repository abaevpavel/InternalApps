import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input, Textarea, Field, Select, Tabs } from '../../components/task-planner-ui'
import { cn, errMsg } from '../../lib/utils'
import { fetchProjects, fetchSkills, fetchTeams, fetchTaskTypes, createTask } from '../../services/task-planner/data'
import { useAuth } from '../../auth/AuthProvider'
import type { Skill, TimeType } from '../../domain/task-planner/types'

/** Следующий рабочий день (пропуская сб/вс) в формате YYYY-MM-DD, по локальному времени. */
function nextWeekdayISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1) // 0=вс, 6=сб
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function CreateTaskPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { authUser } = useAuth()
  const [mode, setMode] = useState<'project' | 'other'>('project')
  const [timeType, setTimeType] = useState<TimeType | null>(null)
  const [stopWhen, setStopWhen] = useState<'before' | 'after'>('after')
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const teams = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })
  const skills = useQuery({ queryKey: ['skills'], queryFn: fetchSkills })
  const taskTypes = useQuery({ queryKey: ['taskTypes'], queryFn: fetchTaskTypes })

  // поля формы
  const [projectId, setProjectId] = useState('')
  const [taskType, setTaskType] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(nextWeekdayISO())
  const [exactTime, setExactTime] = useState('')
  const [tfStart, setTfStart] = useState('')
  const [tfEnd, setTfEnd] = useState('')
  const [durationH, setDurationH] = useState('')
  const [teamId, setTeamId] = useState('')
  const [priority, setPriority] = useState(5)
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [stopAddress, setStopAddress] = useState('')
  const [stopDuration, setStopDuration] = useState(30)
  const [error, setError] = useState<string | null>(null)

  function buildScheduledTime(): Record<string, unknown> | null {
    if (timeType === 'exact' && exactTime) return { type: 'exact', anchor: true, anchor_time: exactTime, start: exactTime }
    if (timeType === 'timeframe' && (tfStart || tfEnd)) return { type: 'timeframe', start: tfStart, end: tfEnd }
    return null
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!taskType) throw new Error('Task Type is required')
      if (!description.trim()) throw new Error('Description is required')
      if (!date) throw new Error('Date is required')
      const hours = parseFloat(durationH)
      if (!hours || hours <= 0) throw new Error('Duration must be > 0')
      const proj = projects.data?.find((p) => p.id === projectId)
      await createTask({
        task_type: taskType,
        project_id: mode === 'project' ? projectId || null : null,
        description: description.trim(),
        scheduled_date: date,
        scheduled_time: buildScheduledTime(),
        estimated_duration_min: Math.round(hours * 60),
        address: proj?.address ?? '',
        project_manager: proj?.project_manager,
        team_id: teamId || null,
        priority,
        skill_requirements: skillIds,
        additional_stop: stopAddress
          ? { when: stopWhen, address: stopAddress, duration_min: stopDuration }
          : null,
        created_by: authUser?.id ?? null,
      })
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      nav('/tasks')
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  return (
    <div>
      <Tabs<'project' | 'other'>
        className="mb-6"
        value={mode}
        onChange={setMode}
        tabs={[
          { key: 'project', label: '📁 New Project Task' },
          { key: 'other', label: '＋ New Other Task' },
        ]}
      />

      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {mode === 'project' && (
            <Field label="Select Project" required>
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Choose a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Task Type" required>
            <Select value={taskType} onChange={(e) => setTaskType(e.target.value)}>
              <option value="">Select task type…</option>
              {taskTypes.data?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Description" required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)}
            rows={4} placeholder="Please be very specific…" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700">Time</label>
              <div className="flex gap-1 text-xs">
                <SegBtn active={timeType === 'exact'} onClick={() => setTimeType('exact')}>EXACT TIME</SegBtn>
                <SegBtn active={timeType === 'timeframe'} onClick={() => setTimeType('timeframe')}>TIMEFRAME</SegBtn>
              </div>
            </div>
            {timeType === 'exact' && <Input type="time" value={exactTime} onChange={(e) => setExactTime(e.target.value)} />}
            {timeType === 'timeframe' && <div className="flex gap-2">
              <Input type="time" value={tfStart} onChange={(e) => setTfStart(e.target.value)} />
              <Input type="time" value={tfEnd} onChange={(e) => setTfEnd(e.target.value)} />
            </div>}
            {!timeType && <Input disabled placeholder="Select time type above" />}
          </div>
          <Field label="Duration (hours)" required>
            <Input value={durationH} onChange={(e) => setDurationH(e.target.value)} placeholder="e.g. 8, 4.5" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assigned Team">
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">No preference</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.value} - {p.label}</option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Required Skills (optional)"
          hint={skillIds.length ? undefined : 'A task can require several skills.'}
        >
          <SkillPicker
            skills={skills.data ?? []}
            selected={skillIds}
            onToggle={(id) =>
              setSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
            }
          />
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700">Additional Stop</label>
            <div className="flex gap-1 text-xs">
              <SegBtn active={stopWhen === 'before'} onClick={() => setStopWhen('before')}>BEFORE</SegBtn>
              <SegBtn active={stopWhen === 'after'} onClick={() => setStopWhen('after')}>AFTER</SegBtn>
            </div>
          </div>
          <Input value={stopAddress} onChange={(e) => setStopAddress(e.target.value)}
            placeholder="Search for any address or place (e.g., Home Depot Beltsville)" />
          <div className="mt-2 w-28">
            <label className="mb-1 block text-xs text-gray-500">Duration (min)</label>
            <Input type="number" value={stopDuration} onChange={(e) => setStopDuration(Number(e.target.value))} />
          </div>
        </div>

        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
        <Button variant="accent" className="w-full" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create Task'}
        </Button>
      </Card>
    </div>
  )
}

/** Маленькая сегмент-кнопка (EXACT/TIMEFRAME, BEFORE/AFTER). */
function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded px-2 py-0.5 font-medium transition', active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
    >
      {children}
    </button>
  )
}

/**
 * Шкала приоритета. Раньше в форме было всего два пункта (5 и 1), хотя остальная апка
 * живёт по 1–10: `priorityTone` в Tasks.tsx считает ≤3 высоким, ≥7 низким, между ними
 * средний, а в редактировании задачи стоит свободный number-input. Подписаны только края
 * и середина — промежуточные значения говорят сами за себя.
 */
const PRIORITY_LABELS: Record<number, string> = { 1: 'Highest', 3: 'High', 5: 'Normal', 7: 'Low', 10: 'Lowest' }
const PRIORITIES = Array.from({ length: 10 }, (_, i) => i + 1).map((value) => ({
  value,
  label: PRIORITY_LABELS[value] ?? '',
}))

/**
 * Выбор требуемых навыков: строка поиска с выпадающим списком, выбранные — чипами под ней.
 *
 * `skill_requirements` в БД — массив, а форма клала туда максимум один элемент; задача может
 * требовать нескольких. Список в поповере, а не развёрнутый набор чекбоксов: навыков в
 * справочнике десятки, и раскрытый список вытеснял бы остальную форму за экран.
 * Уже выбранные из списка убираются — их видно чипами, дублировать незачем.
 */
function SkillPicker({
  skills, selected, onToggle,
}: { skills: Skill[]; selected: string[]; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const byId = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills])

  // Группируем по категории — так же, как Directories: плоский список из десятков позиций
  // не читается. Фильтр по названию и по категории, чтобы «Plumbing» находил всю группу.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = new Map<string, Skill[]>()
    for (const s of skills) {
      if (selected.includes(s.id)) continue
      const cat = s.category || 'Other'
      if (needle && !s.name.toLowerCase().includes(needle) && !cat.toLowerCase().includes(needle)) continue
      out.set(cat, [...(out.get(cat) ?? []), s])
    }
    return [...out.entries()]
  }, [skills, selected, q])

  function pick(id: string) {
    onToggle(id)
    setQ('')
    setOpen(false)
  }

  return (
    <div>
      <div ref={ref} className="relative">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={skills.length ? 'Search and add a skill…' : 'No skills in the directory'}
          disabled={!skills.length}
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Show skills"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
        >
          <ChevronDown size={16} className={cn('transition', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-40 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
            {groups.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-400">
                {q ? 'Nothing matches.' : 'Every skill is already added.'}
              </p>
            ) : (
              groups.map(([cat, list]) => (
                <div key={cat}>
                  <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{cat}</div>
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => pick(s.id)}
                      className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-200 bg-accent-50 px-2.5 py-1 text-sm text-accent-700"
            >
              {byId.get(id)?.name ?? id}
              <button
                type="button"
                onClick={() => onToggle(id)}
                aria-label={`Remove ${byId.get(id)?.name ?? id}`}
                className="text-accent-500 transition hover:text-accent-800"
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
