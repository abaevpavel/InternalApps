import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SquarePen, Trash2 } from 'lucide-react'
import { Button, Card, Input, Field, Select, PageTitle, Badge } from '../../components/task-planner-ui'
import { fetchAvailability, fetchTeams, createAvailability, updateAvailability, deleteAvailability } from '../../services/task-planner/data'
import {
  AVAILABILITY_KINDS, availabilityKindLabel, coversDate, overlappingPeriod, splitByDate, toAvailabilityKind,
  type AvailabilityKind,
} from '../../domain/task-planner/availability'
import type { TeamAvailability } from '../../domain/task-planner/types'
import { cn, errMsg } from '../../lib/utils'
import { todayISO } from './MyTasks'

const KIND_STYLE: Record<AvailabilityKind, string> = {
  vacation: 'bg-blue-50 text-blue-700',
  sick_leave: 'bg-red-50 text-red-700',
  other: 'bg-gray-100 text-gray-600',
}

/**
 * Teams Availability (BAS-1446): отпуск, больничный и т. п. на период дат. Бригада, недоступная
 * в день планирования, в AI не уходит (см. domain/task-planner/availability.ts).
 * Доступ — Admin, PM, Schedule Manager (manage_availability; та же проверка в RLS).
 */
export function AvailabilityPage() {
  const qc = useQueryClient()
  const periods = useQuery({ queryKey: ['availability'], queryFn: fetchAvailability })
  const teams = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [teamId, setTeamId] = useState('')
  const [kind, setKind] = useState<AvailabilityKind>('vacation')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showPast, setShowPast] = useState(false)
  // Рамки (Vlad 22.10.2026): сохранённые периоды — в зелёной рамке; тот, что сейчас правится, —
  // серый, а зелёная рамка переходит на форму.

  const today = todayISO()
  const { upcoming, past } = useMemo(() => splitByDate(periods.data ?? [], today), [periods.data, today])

  const reset = () => {
    setEditingId(null); setTeamId(''); setKind('vacation'); setStart(''); setEnd(''); setNote(''); setError(null)
  }

  const startEdit = (p: TeamAvailability) => {
    setEditingId(p.id); setTeamId(p.team_id); setKind(p.kind); setStart(p.start_date); setEnd(p.end_date)
    setNote(p.note ?? ''); setError(null)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!teamId) throw new Error('Select a team')
      if (!start || !end) throw new Error('Both dates are required')
      if (end < start) throw new Error('End date must be on or after start date')
      const clash = overlappingPeriod(periods.data ?? [], teamId, start, end, editingId)
      if (clash) {
        throw new Error(`This team already has a period ${clash.start_date} — ${clash.end_date} (${availabilityKindLabel(clash.kind)}). Edit it instead.`)
      }
      const input = { teamId, startDate: start, endDate: end, kind, note }
      if (editingId) {
        await updateAvailability(editingId, input)
        return editingId
      }
      return createAvailability(input)
    },
    onSuccess: () => {
      reset()
      qc.invalidateQueries({ queryKey: ['availability'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  const del = useMutation({
    mutationFn: (id: string) => deleteAvailability(id),
    onSuccess: (_d, id) => {
      if (id === editingId) reset()
      qc.invalidateQueries({ queryKey: ['availability'] })
    },
    onError: (e: unknown) => alert(errMsg(e)),
  })

  const row = (p: TeamAvailability) => (
    <div key={p.id} className={cn(
      'flex items-start justify-between gap-3 rounded-lg border p-3 transition',
      p.id === editingId ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-green-500 ring-1 ring-green-500',
    )}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-gray-100 text-gray-700">{p.team_name}</Badge>
          <Badge className={KIND_STYLE[p.kind]}>{availabilityKindLabel(p.kind)}</Badge>
          {coversDate(p, today) && <Badge className="bg-amber-50 text-amber-700">Now</Badge>}
        </div>
        <p className="mt-1 text-sm text-gray-600">{p.start_date} — {p.end_date}</p>
        {p.note && <p className="mt-0.5 text-xs text-gray-500">{p.note}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button className="text-gray-400 hover:text-accent-600" aria-label="edit" title="Edit period" onClick={() => startEdit(p)}>
          <SquarePen size={16} />
        </button>
        <button
          className="text-gray-400 hover:text-red-600 disabled:opacity-50"
          aria-label="delete" title="Delete period" disabled={del.isPending}
          onClick={() => { if (confirm(`Delete unavailable period for ${p.team_name}?`)) del.mutate(p.id) }}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  )

  return (
    <div>
      <PageTitle title="Teams Availability"
        subtitle="Vacations, sick leaves and other days off. A crew that is unavailable on the planning day is not sent to AI." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className={cn('p-6 transition', editingId && 'border-green-500 ring-2 ring-green-500')}>
          <h2 className="mb-1 text-lg font-semibold text-gray-900">{editingId ? 'Edit Unavailable Period' : 'Add Unavailable Period'}</h2>
          <p className="mb-4 text-sm text-gray-500">Select a team and specify when and why they will be unavailable</p>
          <Field label="Team" className="mb-4">
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={teams.isLoading}>
              <option value="">Select a team</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Reason" className="mb-4">
            <Select value={kind} onChange={(e) => setKind(toAvailabilityKind(e.target.value))}>
              {AVAILABILITY_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="End Date"><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          <Field label="Note" className="mt-4">
            <Input value={note} maxLength={300} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
          <div className="mt-5 flex gap-2">
            {editingId && <Button variant="ghost" disabled={save.isPending} onClick={reset}>Cancel</Button>}
            <Button variant="accent" className="flex-1" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : editingId ? 'Save Changes' : 'Add Unavailable Period'}
            </Button>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Current and Upcoming</h2>
          <p className="mb-4 text-sm text-gray-500">These crews are not sent to AI on these days</p>
          {periods.isLoading && <p className="text-sm text-gray-400">Loading…</p>}
          {periods.isError && <p className="text-sm text-red-600">⚠ {errMsg(periods.error)}</p>}
          {!periods.isLoading && !upcoming.length && <p className="text-sm text-gray-500">No current or upcoming periods.</p>}
          <div className="space-y-2">{upcoming.map(row)}</div>

          {past.length > 0 && (
            <div className="mt-6">
              <button className="text-sm font-medium text-gray-500 hover:text-gray-800" onClick={() => setShowPast((v) => !v)}>
                {showPast ? 'Hide' : 'Show'} past periods ({past.length})
              </button>
              {showPast && <div className="mt-2 space-y-2 opacity-70">{past.map(row)}</div>}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
