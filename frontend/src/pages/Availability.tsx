import { useQuery } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { Button, Card, Input, Field, Select, PageTitle, Badge } from '../components/ui'
import { fetchAvailability, fetchTeams } from '../services/data'

export function AvailabilityPage() {
  const { data: periods } = useQuery({ queryKey: ['availability'], queryFn: fetchAvailability })
  const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })

  return (
    <div>
      <PageTitle title="Teams Availability" subtitle="Manage team unavailable dates and periods" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Add Unavailable Period</h2>
          <p className="mb-4 text-sm text-gray-500">Select a team and specify when they will be unavailable</p>
          <Field label="Team" className="mb-4">
            <Select>
              <option>Select a team</option>
              {teams?.map((t) => <option key={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date"><Input type="date" /></Field>
            <Field label="End Date"><Input type="date" /></Field>
          </div>
          <Button variant="accent" className="mt-5 w-full">Add Unavailable Period</Button>
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Current Unavailable Periods</h2>
          <p className="mb-4 text-sm text-gray-500">View and manage existing team unavailability</p>
          <div className="space-y-2">
            {periods?.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-3">
                <div className="flex items-center gap-3">
                  <Badge className="bg-gray-100 text-gray-600">{p.team_name}</Badge>
                  <span className="text-sm text-gray-600">{p.start_date} — {p.end_date}</span>
                </div>
                <button className="text-gray-400 hover:text-red-600" aria-label="delete"><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
