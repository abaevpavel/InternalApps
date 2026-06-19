import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button, Card, PageTitle, Badge, Tabs, DataTable, Cell, type Column } from '../components/ui'
import { fetchProjects, fetchSkills, fetchTeams } from '../services/data'
import type { Project, Team, Skill } from '../domain/types'

type Tab = 'projects' | 'team' | 'skills' | 'task_types'
const TABS: { key: Tab; label: string }[] = [
  { key: 'projects', label: 'Projects' },
  { key: 'team', label: 'Team' },
  { key: 'skills', label: 'Skills' },
  { key: 'task_types', label: 'Task Types' },
]

const projectCols: Column<Project>[] = [
  { key: 'name', header: 'Project', render: (p) => <Cell title={p.name} sub={p.address} /> },
  { key: 'pm', header: 'Project Manager', align: 'right', render: (p) => <Badge className="bg-gray-100 text-gray-600">{p.project_manager}</Badge> },
]
const teamCols: Column<Team>[] = [
  { key: 'name', header: 'Team', render: (t) => <Cell title={t.name} sub={t.home_address} /> },
  { key: 'skills', header: 'Skills', align: 'right', render: (t) => <Badge className="bg-gray-100 text-gray-600">{t.skills.length} skills</Badge> },
]
const skillCols: Column<Skill>[] = [
  { key: 'name', header: 'Skill', render: (s) => <Cell title={s.name} sub={s.description ?? '—'} /> },
  { key: 'cat', header: 'Category', align: 'right', render: (s) => <Badge className="bg-accent-50 text-accent-700">{s.category}</Badge> },
]

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('skills')
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const teams = useQuery({ queryKey: ['teams'], queryFn: fetchTeams })
  const skills = useQuery({ queryKey: ['skills'], queryFn: fetchSkills })

  return (
    <div>
      <Tabs<Tab> className="mb-6" value={tab} onChange={setTab} tabs={TABS} />

      <PageTitle
        title={TABS.find((t) => t.key === tab)!.label}
        actions={<Button variant="accent"><RefreshCw size={16} /> Sync from Airtable</Button>}
      />

      <Card>
        {tab === 'projects' && (
          <DataTable columns={projectCols} rows={projects.data ?? []} getRowKey={(p) => p.id} empty="No projects." />
        )}
        {tab === 'team' && (
          <DataTable columns={teamCols} rows={teams.data ?? []} getRowKey={(t) => t.id} empty="No teams." />
        )}
        {tab === 'skills' && (
          <DataTable columns={skillCols} rows={skills.data ?? []} getRowKey={(s) => s.id} empty="No skills." />
        )}
        {tab === 'task_types' && (
          <div className="p-4 text-sm text-gray-500">Project task · Other task</div>
        )}
      </Card>
    </div>
  )
}
