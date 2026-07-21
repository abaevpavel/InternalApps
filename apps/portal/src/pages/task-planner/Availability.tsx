import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { Button, Card, Input, Field, Select, PageTitle, Badge } from '../../components/task-planner-ui'
import { fetchAvailability, fetchTeams, createAvailability, deleteAvailability } from '../../services/task-planner/data'
import { errMsg } from '../../lib/utils'

export function AvailabilityPage() {
  const qc = useQueryClient()
  const periods = useQuery({ queryKey: ['availability'], queryFn: fetchAvailability })
  const teams = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })

  const [teamId, setTeamId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: async () => {
      if (!teamId) throw new Error('Select a team')
      if (!start || !end) throw new Error('Both dates are required')
      if (end < start) throw new Error('End date must be on or after start date')
      await createAvailability(teamId, start, end)
    },
    onSuccess: () => {
      setError(null); setTeamId(''); setStart(''); setEnd('')
      qc.invalidateQueries({ queryKey: ['availability'] })
    },
    onError: (e: unknown) => setError(errMsg(e)),
  })

  const del = useMutation({
    mutationFn: (id: string) => deleteAvailability(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['availability'] }),
    onError: (e: unknown) => alert(errMsg(e)),
  })

  return (
    <div>
      <PageTitle title="Teams Availability" subtitle="Manage team unavailable dates and periods" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Add Unavailable Period</h2>
          <p className="mb-4 text-sm text-gray-500">Select a team and specify when they will be unavailable</p>
          <Field label="Team" className="mb-4">
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={teams.isLoading}>
              <option value="">Select a team</option>
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="End Date"><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
          <Button variant="accent" className="mt-5 w-full" disabled={add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Add Unavailable Period'}
          </Button>
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Current Unavailable Periods</h2>
          <p className="mb-4 text-sm text-gray-500">View and manage existing team unavailability</p>
          {periods.isLoading && <p className="text-sm text-gray-400">Loading…</p>}
          {periods.isError && <p className="text-sm text-red-600">⚠ {errMsg(periods.error)}</p>}
          {!periods.isLoading && !periods.data?.length && <p className="text-sm text-gray-500">No unavailable periods.</p>}
          <div className="space-y-2">
            {periods.data?.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-3">
                <div className="flex items-center gap-3">
                  <Badge className="bg-gray-100 text-gray-600">{p.team_name}</Badge>
                  <span className="text-sm text-gray-600">{p.start_date} — {p.end_date}</span>
                </div>
                <button
                  className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                  aria-label="delete" disabled={del.isPending}
                  onClick={() => { if (confirm(`Delete unavailable period for ${p.team_name}?`)) del.mutate(p.id) }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
