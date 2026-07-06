import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { createRole, deleteRole, listApplications, listRoles, updateRole } from '../../services/data'
import { Badge, Button, Card, DataTable, Field, Input, Modal, Textarea, type Column } from '../../components/ui'
import { errMsg } from '../../lib/utils'
import { roleIsAdmin, type Role } from '../../domain/types'

const VISIBLE_APP_BADGES = 3

export function RolesTab() {
  const qc = useQueryClient()
  const { data: roles = [], isLoading } = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const { data: apps = [] } = useQuery({ queryKey: ['applications'], queryFn: listApplications })

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Role | null>(null)
  const [deleting, setDeleting] = useState<Role | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['roles'] })
    qc.invalidateQueries({ queryKey: ['profiles'] })
    qc.invalidateQueries({ queryKey: ['role-applications'] })
  }

  const columns: Column<Role>[] = [
    {
      key: 'name',
      header: 'Role Name',
      render: (r) => <span className="font-semibold text-gray-900">{r.name}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      className: 'max-w-[16rem]',
      render: (r) => <span className="block truncate">{r.description ?? '—'}</span>,
    },
    {
      key: 'applications',
      header: 'Applications',
      render: (r) => (
        <div className="flex max-w-md flex-wrap gap-1.5">
          {r.applications.slice(0, VISIBLE_APP_BADGES).map((a) => (
            <Badge key={a.id} className="bg-blue-50 text-blue-700">{a.name}</Badge>
          ))}
          {r.applications.length > VISIBLE_APP_BADGES && (
            <Badge className="bg-green-500 text-white">
              +{r.applications.length - VISIBLE_APP_BADGES} more
            </Badge>
          )}
          {r.applications.length === 0 && <span className="text-gray-400">No applications</span>}
        </div>
      ),
    },
    { key: 'created', header: 'Created', render: (r) => format(new Date(r.created_at), 'dd.MM.yyyy') },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing(r)} className="text-gray-400 hover:text-gray-700" aria-label="edit">
            <Pencil size={16} />
          </button>
          <button
            onClick={() => setDeleting(r)}
            disabled={roleIsAdmin(r)}
            title={roleIsAdmin(r) ? 'The admin role cannot be deleted' : undefined}
            className="text-red-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="delete"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Roles</h1>
          <p className="mt-1 text-sm text-gray-500">
            Showing {roles.length} roles · {apps.length} applications available
          </p>
        </div>
        <Button variant="blue" onClick={() => setCreating(true)}>
          <Plus size={15} /> Create Role
        </Button>
      </div>

      <Card>
        {isLoading ? (
          <div className="px-4 py-10 text-center text-sm text-gray-400">Loading…</div>
        ) : (
          <DataTable columns={columns} rows={roles} getRowKey={(r) => r.id} empty="No roles yet." />
        )}
      </Card>

      {creating && <RoleModal title="Create Role" onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <RoleModal title="Edit Role" role={editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      )}
      {deleting && (
        <DeleteRoleModal role={deleting} onClose={() => setDeleting(null)} onDeleted={invalidate} />
      )}
    </div>
  )
}

/* ---------------- Create / Edit ---------------- */

function RoleModal({
  title, role, onClose, onSaved,
}: { title: string; role?: Role; onClose: () => void; onSaved: () => void }) {
  const { data: apps = [] } = useQuery({ queryKey: ['applications'], queryFn: listApplications })
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.applications.map((a) => a.id) ?? []))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const mut = useMutation({
    mutationFn: async () => {
      const input = { name, description, application_ids: [...selected] }
      if (role) await updateRole(role.id, input)
      else await createRole(input)
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  return (
    <Modal
      open
      title={title}
      subtitle="Select which applications this role can access."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="blue" disabled={!name.trim() || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Role name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HR Manager" />
        </Field>
        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What is this role for?"
          />
        </Field>
        <Field label="Applications">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {apps.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5 text-sm hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggle(a.id)}
                  className="h-4 w-4 accent-blue-600"
                />
                <span className="text-gray-800">{a.name}</span>
              </label>
            ))}
          </div>
        </Field>
        {mut.isError && <p className="text-sm text-red-600">{errMsg(mut.error)}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Delete ---------------- */

function DeleteRoleModal({
  role, onClose, onDeleted,
}: { role: Role; onClose: () => void; onDeleted: () => void }) {
  const mut = useMutation({
    mutationFn: () => deleteRole(role.id),
    onSuccess: () => {
      onDeleted()
      onClose()
    },
  })

  return (
    <Modal
      open
      title="Delete role"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    >
      <p>
        Delete role <span className="font-semibold">{role.name}</span>? Users with this role will keep
        their account but lose access to its applications until a new role is assigned.
      </p>
      {mut.isError && <p className="mt-2 text-sm text-red-600">{errMsg(mut.error)}</p>}
    </Modal>
  )
}
