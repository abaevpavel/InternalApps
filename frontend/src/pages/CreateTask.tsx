import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input } from '../components/ui'
import { cn } from '../lib/utils'
import { fetchProjects, fetchSkills, fetchTeams, createTask } from '../services/data'
import { useAuth } from '../auth/AuthProvider'
import type { TimeType } from '../domain/types'

export function CreateTaskPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const [mode, setMode] = useState<'project' | 'other'>('project')
  const [timeType, setTimeType] = useState<TimeType | null>(null)
  const [stopWhen, setStopWhen] = useState<'before' | 'after'>('after')
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const teams = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })
  const skills = useQuery({ queryKey: ['skills'], queryFn: fetchSkills })

  // поля формы
  const [projectId, setProjectId] = useState('')
  const [taskType, setTaskType] = useState('Project task')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [exactTime, setExactTime] = useState('')
  const [tfStart, setTfStart] = useState('')
  const [tfEnd, setTfEnd] = useState('')
  const [durationH, setDurationH] = useState('')
  const [teamId, setTeamId] = useState('')
  const [priority, setPriority] = useState(5)
  const [skillId, setSkillId] = useState('')
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
      if (!description.trim()) throw new Error('Description обязателен')
      if (!date) throw new Error('Date обязателен')
      const hours = parseFloat(durationH)
      if (!hours || hours <= 0) throw new Error('Duration должен быть > 0')
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
        skill_requirements: skillId ? [skillId] : [],
        additional_stop: stopAddress
          ? { when: stopWhen, address: stopAddress, duration_min: stopDuration }
          : null,
        created_by: user?.id ?? null,
      })
    },
    onSuccess: () => {
      setError(null)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      nav('/tasks')
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div>
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-100 p-1">
        <button onClick={() => setMode('project')} className={cn('flex-1 rounded-md py-2 text-sm font-medium', mode === 'project' ? 'bg-white shadow' : 'text-gray-500')}>📁 New Project Task</button>
        <button onClick={() => setMode('other')} className={cn('flex-1 rounded-md py-2 text-sm font-medium', mode === 'other' ? 'bg-white shadow' : 'text-gray-500')}>＋ New Other Task</button>
      </div>

      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {mode === 'project' && (
            <div>
              <label className="mb-1 block text-sm font-medium">Select Project *</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Choose a project…</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">Task Type *</label>
            <select value={taskType} onChange={(e) => setTaskType(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option>Project task</option><option>Other task</option>
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Description *</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" rows={4} placeholder="Please be very specific…" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Date *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium">Time</label>
              <div className="flex gap-1 text-xs">
                <button onClick={() => setTimeType('exact')} className={cn('rounded px-2 py-0.5', timeType === 'exact' ? 'bg-gray-900 text-white' : 'bg-gray-100')}>EXACT TIME</button>
                <button onClick={() => setTimeType('timeframe')} className={cn('rounded px-2 py-0.5', timeType === 'timeframe' ? 'bg-gray-900 text-white' : 'bg-gray-100')}>TIMEFRAME</button>
              </div>
            </div>
            {timeType === 'exact' && <Input type="time" value={exactTime} onChange={(e) => setExactTime(e.target.value)} />}
            {timeType === 'timeframe' && <div className="flex gap-2">
              <Input type="time" value={tfStart} onChange={(e) => setTfStart(e.target.value)} />
              <Input type="time" value={tfEnd} onChange={(e) => setTfEnd(e.target.value)} />
            </div>}
            {!timeType && <Input disabled placeholder="Select time type above" />}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Duration * (hours)</label>
            <Input value={durationH} onChange={(e) => setDurationH(e.target.value)} placeholder="e.g. 8, 4.5" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Assigned Team</label>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">No preference</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Priority</label>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value={5}>5 - Normal</option><option value={1}>1 - Highest</option>
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Required Skills (optional)</label>
          <select value={skillId} onChange={(e) => setSkillId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Add Required Skill</option>
            {skills.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">Additional Stop</label>
            <div className="flex gap-1 text-xs">
              <button onClick={() => setStopWhen('before')} className={cn('rounded px-2 py-0.5', stopWhen === 'before' ? 'bg-gray-900 text-white' : 'bg-gray-100')}>BEFORE</button>
              <button onClick={() => setStopWhen('after')} className={cn('rounded px-2 py-0.5', stopWhen === 'after' ? 'bg-gray-900 text-white' : 'bg-gray-100')}>AFTER</button>
            </div>
          </div>
          <Input value={stopAddress} onChange={(e) => setStopAddress(e.target.value)}
            placeholder="Search for any address or place (e.g., Home Depot Beltsville)" />
          <div className="mt-2 flex items-end gap-3">
            <div className="w-24">
              <label className="mb-1 block text-xs text-gray-500">Duration (min)</label>
              <Input type="number" value={stopDuration} onChange={(e) => setStopDuration(Number(e.target.value))} />
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
        <Button variant="amber" className="w-full" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create Task'}
        </Button>
      </Card>
    </div>
  )
}
