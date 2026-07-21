import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Plus, SquarePen, Trash2, KeyRound } from 'lucide-react'
import { Button, Card, PageTitle, Badge, Tabs, DataTable, Modal, Input, Textarea, Field, Select, type Column } from '../components/ui'
import {
  fetchProjects, fetchSkills, fetchTeamMembers, fetchTaskTypes,
  createTaskType, updateTaskType, deleteTaskType, runEdgeSync, setTeamPassword,
} from '../services/data'
import { errMsg } from '../lib/utils'
import type { Project, Skill, TaskType, TeamMember } from '../domain/types'

type Tab = 'projects' | 'team' | 'skills' | 'task_types'
const TABS: { key: Tab; label: string }[] = [
  { key: 'projects', label: 'Projects' },
  { key: 'team', label: 'Team' },
  { key: 'skills', label: 'Skills' },
  { key: 'task_types', label: 'Task Types' },
]

const projectCols: Column<Project>[] = [
  { key: 'name', header: 'Name', render: (p) => <span className="font-medium text-gray-900">{p.name}</span> },
  { key: 'address', header: 'Address', render: (p) => <span className="text-gray-600">{p.address || '—'}</span> },
  { key: 'pm', header: 'Project Manager', render: (p) => <span className="text-gray-600">{p.project_manager || '—'}</span> },
  { key: 'slack', header: 'Slack id', render: (p) => <span className="text-xs text-gray-500">{p.slack_id || '—'}</span> },
]
const teamCols: Column<TeamMember>[] = [
  { key: 'name', header: 'Name', render: (t) => <span className="font-medium text-gray-900">{t.name}</span> },
  { key: 'email', header: 'Email', render: (t) => <span className="text-gray-600">{t.email || '—'}</span> },
  { key: 'address', header: 'Address', render: (t) => <span className="text-gray-600">{t.address || '—'}</span> },
  { key: 'role', header: 'Role', render: (t) => t.role ? <Badge className="bg-accent-50 text-accent-700">{t.role}</Badge> : <span className="text-gray-400">—</span> },
  {
    key: 'status', header: 'Status', align: 'right',
    render: (t) => <Badge className={t.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}>{t.status || '—'}</Badge>,
  },
]

export function AdminPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('projects')
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const team = useQuery({ queryKey: ['teamMembers'], queryFn: fetchTeamMembers })
  const skills = useQuery({ queryKey: ['skills'], queryFn: fetchSkills })
  const taskTypes = useQuery({ queryKey: ['taskTypes'], queryFn: fetchTaskTypes })

  // skills сгруппированы по категории (как в Lovable)
  const skillGroups = useMemo(() => {
    const m = new Map<string, Skill[]>()
    for (const s of skills.data ?? []) {
      const c = s.category || 'Uncategorized'
      if (!m.has(c)) m.set(c, [])
      m.get(c)!.push(s)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [skills.data])

  const [editTT, setEditTT] = useState<TaskType | 'new' | null>(null)
  const [pwdFor, setPwdFor] = useState<TeamMember | null>(null)

  const teamColumns: Column<TeamMember>[] = [
    ...teamCols,
    {
      key: 'actions', header: '', align: 'right',
      render: (t) => (
        <Button variant="outline" onClick={() => setPwdFor(t)} disabled={!t.email}>
          <KeyRound size={15} /> Set password
        </Button>
      ),
    },
  ]

  // синк из Airtable через Supabase Edge Functions
  const sync = useMutation({
    mutationFn: (fns: string[]) => runEdgeSync(fns),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: unknown) => alert(errMsg(e)),
  })
  const SyncBtn = ({ fns, label }: { fns: string[]; label: string }) => (
    <Button variant="accent" disabled={sync.isPending} onClick={() => sync.mutate(fns)}>
      <RefreshCw size={16} className={sync.isPending ? 'animate-spin' : ''} /> {sync.isPending ? 'Syncing…' : label}
    </Button>
  )

  const actions =
    tab === 'projects' ? <SyncBtn fns={['sync-airtable-projects']} label="Sync from Airtable" /> :
    tab === 'skills' ? <SyncBtn fns={['sync-airtable-skills']} label="Sync from Airtable" /> :
    tab === 'team' ? (
      <div className="flex gap-2">
        <SyncBtn fns={['sync-airtable-teams']} label="Sync Teams info" />
        <SyncBtn fns={['sync-airtable-teams', 'sync-airtable-skills']} label="Sync Teams & Skills" />
      </div>
    ) : (
      <Button variant="accent" onClick={() => setEditTT('new')}><Plus size={16} /> Add Task Type</Button>
    )

  return (
    <div>
      <Tabs<Tab> className="mb-6" value={tab} onChange={setTab} tabs={TABS} />
      <PageTitle title={TABS.find((t) => t.key === tab)!.label} actions={actions} />

      {tab === 'projects' && (
        <Card><DataTable columns={projectCols} rows={projects.data ?? []} getRowKey={(p) => p.id} empty="No projects." /></Card>
      )}

      {tab === 'team' && (
        <Card><DataTable columns={teamColumns} rows={team.data ?? []} getRowKey={(t) => t.id} empty="No team accounts." /></Card>
      )}

      {tab === 'skills' && (
        <div className="space-y-4">
          {skillGroups.length === 0 && <Card><p className="p-4 text-sm text-gray-500">No skills.</p></Card>}
          {skillGroups.map(([cat, list]) => (
            <Card key={cat}>
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <span className="text-sm font-semibold uppercase tracking-wide text-gray-700">{cat}</span>
                <Badge className="bg-gray-100 text-gray-600">{list.length}</Badge>
              </div>
              <ul className="divide-y divide-gray-100">
                {list.map((s, i) => (
                  <li key={s.id} className="flex gap-4 px-4 py-2.5 text-sm">
                    <span className="w-6 shrink-0 text-gray-400">{i + 1}</span>
                    <span className="w-64 shrink-0 font-medium text-gray-900">{s.name}</span>
                    <span className="text-gray-500">{s.description || '—'}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {tab === 'task_types' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(taskTypes.data ?? []).map((tt) => (
            <Card key={tt.id} className="flex items-start justify-between p-4">
              <div>
                <div className="font-semibold text-gray-900">{tt.name}</div>
                {tt.description && <div className="mt-1 text-sm text-gray-500">{tt.description}</div>}
              </div>
              <div className="flex gap-2 text-gray-400">
                <button onClick={() => setEditTT(tt)} className="hover:text-accent-600" aria-label="edit"><SquarePen size={16} /></button>
                <TaskTypeDelete id={tt.id} name={tt.name} onDone={() => qc.invalidateQueries({ queryKey: ['taskTypes'] })} />
              </div>
            </Card>
          ))}
          {!taskTypes.data?.length && <p className="text-sm text-gray-500">No task types.</p>}
        </div>
      )}


      {editTT && (
        <TaskTypeModal
          tt={editTT === 'new' ? null : editTT}
          onClose={() => setEditTT(null)}
          onSaved={() => { setEditTT(null); qc.invalidateQueries({ queryKey: ['taskTypes'] }) }}
        />
      )}

      {pwdFor && (
        <SetPasswordModal
          member={pwdFor}
          onClose={() => setPwdFor(null)}
          onSaved={() => { setPwdFor(null); qc.invalidateQueries({ queryKey: ['teamMembers'] }) }}
        />
      )}
    </div>
  )
}

/** Задать пароль + роль члену бригады (Edge Function set-team-password, super_admin only). */
function SetPasswordModal({ member, onClose, onSaved }: { member: TeamMember; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('team_lead')
  const [error, setError] = useState<string | null>(null)

  const [first, ...rest] = (member.name || '').trim().split(/\s+/)
  const save = useMutation({
    mutationFn: async () => {
      if (password.length < 6) throw new Error('Password must be at least 6 characters')
      await setTeamPassword({
        email: member.email!,
        password,
        role,
        first_name: first || null,
        last_name: rest.join(' ') || null,
      })
    },
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })

  return (
    <Modal
      open title={`Set password — ${member.name}`} onClose={onClose}
      subtitle="Creates the login account if it doesn't exist yet, otherwise resets the password."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending || password.length < 6} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      <div className="space-y-3">
        <Field label="Email"><Input value={member.email ?? ''} disabled /></Field>
        <Field label="Password" required hint="Min 6 characters. The PM signs in with email + this password.">
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Set a password" autoFocus />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="team_lead">Team Lead (PM)</option>
            <option value="pm">PM</option>
            <option value="super_admin">Super Admin</option>
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
      </div>
    </Modal>
  )
}

function TaskTypeDelete({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const del = useMutation({ mutationFn: () => deleteTaskType(id), onSuccess: onDone, onError: (e) => alert(errMsg(e)) })
  return (
    <button
      onClick={() => { if (confirm(`Delete task type “${name}”?`)) del.mutate() }}
      disabled={del.isPending} className="hover:text-red-600" aria-label="delete"
    >
      <Trash2 size={16} />
    </button>
  )
}

function TaskTypeModal({ tt, onClose, onSaved }: { tt: TaskType | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(tt?.name ?? '')
  const [desc, setDesc] = useState(tt?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('Name is required')
      if (tt) await updateTaskType(tt.id, name.trim(), desc.trim() || undefined)
      else await createTaskType(name.trim(), desc.trim() || undefined)
    },
    onSuccess: onSaved,
    onError: (e: unknown) => setError(errMsg(e)),
  })
  return (
    <Modal
      open title={tt ? 'Edit Task Type' : 'Add Task Type'} onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <div className="space-y-3">
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Inspection" /></Field>
        <Field label="Description"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" /></Field>
        {error && <p className="text-sm text-red-600">⚠ {error}</p>}
      </div>
    </Modal>
  )
}
