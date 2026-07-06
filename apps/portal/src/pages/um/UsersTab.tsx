import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { MailX, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import {
  createInvitation, deleteInvitation, deleteUser, listPendingInvitations, listProfiles,
  listRoles, setUserRoles, updateProfileName,
} from '../../services/data'
import { Badge, Button, Card, DataTable, Field, Input, Modal, Select, type Column } from '../../components/ui'
import { errMsg, initials } from '../../lib/utils'
import { fullName, type Invitation, type Profile, type Role } from '../../domain/types'
import { useAuth } from '../../auth/AuthProvider'

type SortKey = 'name' | 'joined'

/** Строка списка — либо реальный юзер, либо ещё не принятое приглашение. */
type Row = { kind: 'user'; user: Profile } | { kind: 'invite'; invite: Invitation }

function inviteRoleNames(invite: Invitation, roles: Role[]): string[] {
  return invite.role_ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean) as string[]
}

export function UsersTab() {
  const qc = useQueryClient()
  const { authUser } = useAuth()
  const { data: users = [], isLoading, error } = useQuery({ queryKey: ['profiles'], queryFn: listProfiles })
  const { data: invites = [] } = useQuery({ queryKey: ['invitations'], queryFn: listPendingInvitations })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: listRoles })

  const [roleFilter, setRoleFilter] = useState<'all' | string>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [search, setSearch] = useState('')

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [deleting, setDeleting] = useState<Profile | null>(null)
  const [revoking, setRevoking] = useState<Invitation | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['profiles'] })
    qc.invalidateQueries({ queryKey: ['invitations'] })
    qc.invalidateQueries({ queryKey: ['user-applications'] })
  }

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase()

    let u = users
    if (roleFilter !== 'all') u = u.filter((x) => x.roles.some((r) => r.id === roleFilter))
    if (q) u = u.filter((x) => fullName(x).toLowerCase().includes(q) || x.email.toLowerCase().includes(q))
    u = [...u].sort((a, b) =>
      sortKey === 'name'
        ? (fullName(a) || a.email).localeCompare(fullName(b) || b.email)
        : a.created_at.localeCompare(b.created_at),
    )

    let inv = invites
    if (roleFilter !== 'all') inv = inv.filter((x) => x.role_ids.includes(roleFilter))
    if (q) inv = inv.filter((x) => x.email.toLowerCase().includes(q))

    // Приглашения сверху — это то, что требует действия админа.
    return [
      ...inv.map((invite) => ({ kind: 'invite', invite }) as Row),
      ...u.map((user) => ({ kind: 'user', user }) as Row),
    ]
  }, [users, invites, roleFilter, search, sortKey])

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => {
        if (row.kind === 'invite') {
          return (
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-700">
                {initials(null, row.invite.email)}
              </span>
              <Badge className="bg-amber-50 text-amber-700">Invited</Badge>
            </div>
          )
        }
        const name = fullName(row.user)
        return (
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-100 text-sm font-semibold text-purple-700">
              {initials(name, row.user.email)}
            </span>
            <span className="font-semibold text-gray-900">{name || '—'}</span>
          </div>
        )
      },
    },
    { key: 'email', header: 'Email', render: (row) => (row.kind === 'invite' ? row.invite.email : row.user.email) },
    {
      key: 'role',
      header: 'Role',
      render: (row) => {
        const names = row.kind === 'invite' ? inviteRoleNames(row.invite, roles) : row.user.roles.map((r) => r.name)
        return names.length ? names.join(', ') : <span className="text-gray-400">No role</span>
      },
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (row) =>
        row.kind === 'invite' ? (
          <span className="text-gray-400">Invited {format(new Date(row.invite.created_at), 'dd.MM.yyyy')}</span>
        ) : (
          format(new Date(row.user.created_at), 'dd.MM.yyyy')
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) =>
        row.kind === 'invite' ? (
          <button
            onClick={() => setRevoking(row.invite)}
            className="flex items-center gap-1 text-red-400 hover:text-red-600"
            aria-label="revoke invitation"
            title="Revoke invitation"
          >
            <MailX size={16} />
            <span className="text-xs">Revoke</span>
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <button onClick={() => setEditing(row.user)} className="text-gray-400 hover:text-gray-700" aria-label="edit">
              <Pencil size={16} />
            </button>
            <button
              onClick={() => setDeleting(row.user)}
              disabled={row.user.user_id === authUser?.id}
              title={row.user.user_id === authUser?.id ? 'You cannot delete yourself' : undefined}
              className="text-red-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ),
    },
  ]

  const userCount = rows.filter((r) => r.kind === 'user').length
  const inviteCount = rows.filter((r) => r.kind === 'invite').length

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Users</h1>
          <p className="mt-1 text-sm text-gray-500">
            Showing {userCount} users{inviteCount > 0 && ` · ${inviteCount} invited`}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="w-44">
            <option value="all">All users ({users.length})</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
          <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="w-40">
            <option value="name">Sort by Name</option>
            <option value="joined">Sort by Joined</option>
          </Select>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for a user"
              className="w-56 pl-9"
            />
          </div>
          <Button variant="blue" onClick={() => setAdding(true)}>
            <Plus size={15} /> Add User
          </Button>
        </div>
      </div>

      <Card>
        {isLoading ? (
          <div className="px-4 py-10 text-center text-sm text-gray-400">Loading…</div>
        ) : error ? (
          <div className="px-4 py-10 text-center text-sm text-red-600">{errMsg(error)}</div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => (r.kind === 'invite' ? `inv-${r.invite.id}` : `usr-${r.user.id}`)}
            empty="No users found."
          />
        )}
      </Card>

      {adding && (
        <AddUserModal invitedBy={authUser?.id ?? ''} onClose={() => setAdding(false)} onSaved={invalidate} />
      )}
      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      {deleting && <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} onDeleted={invalidate} />}
      {revoking && <RevokeInviteModal invite={revoking} onClose={() => setRevoking(null)} onDone={invalidate} />}
    </div>
  )
}

/* ---------------- Add User (invitation) ---------------- */

function AddUserModal({
  invitedBy, onClose, onSaved,
}: { invitedBy: string; onClose: () => void; onSaved: () => void }) {
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState('')

  const mut = useMutation({
    mutationFn: () =>
      createInvitation({ email, role_ids: roleId ? [roleId] : [], invited_by: invitedBy }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  const valid = /\S+@\S+\.\S+/.test(email.trim())

  return (
    <Modal
      open
      title="Add User"
      subtitle="An invitation is created. The user will get access after signing in with Google using this email."
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="blue" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Sending…' : 'Add User'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email" required>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@achgroupllc.com" />
        </Field>
        <Field label="Role">
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">No role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
        {mut.isError && <p className="text-sm text-red-600">{errMsg(mut.error)}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Edit User (name + role) ---------------- */

function EditUserModal({
  user, onClose, onSaved,
}: { user: Profile; onClose: () => void; onSaved: () => void }) {
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const [first, setFirst] = useState(user.first_name ?? '')
  const [last, setLast] = useState(user.last_name ?? '')
  const [roleId, setRoleId] = useState(user.roles[0]?.id ?? '')

  const currentRoleId = user.roles[0]?.id ?? ''

  const mut = useMutation({
    mutationFn: async () => {
      await updateProfileName(user.id, first.trim() || null, last.trim() || null)
      // Роль трогаем только если реально изменилась — иначе лишний destructive
      // DELETE+INSERT в user_roles (и лишний повод упереться в RLS).
      if (user.user_id && roleId !== currentRoleId) {
        await setUserRoles(user.user_id, roleId ? [roleId] : [])
      }
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  return (
    <Modal
      open
      title="Edit User"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="blue" disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={first} onChange={(e) => setFirst(e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label="Email">
          <Input value={user.email} disabled />
        </Field>
        <Field label="Role" hint={user.user_id ? undefined : 'Role can be set after the user first signs in.'}>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={!user.user_id}>
            <option value="">No role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </Field>
        {mut.isError && <p className="text-sm text-red-600">{errMsg(mut.error)}</p>}
      </div>
    </Modal>
  )
}

/* ---------------- Delete ---------------- */

function DeleteUserModal({
  user, onClose, onDeleted,
}: { user: Profile; onClose: () => void; onDeleted: () => void }) {
  const mut = useMutation({
    mutationFn: () => {
      if (!user.user_id) throw new Error('This user has no linked account yet.')
      return deleteUser(user.user_id)
    },
    onSuccess: () => {
      onDeleted()
      onClose()
    },
  })

  return (
    <Modal
      open
      title="Delete user"
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
        Remove <span className="font-semibold">{fullName(user) || user.email}</span> from the portal?
        They will lose access to all applications immediately.
      </p>
      {mut.isError && <p className="mt-2 text-sm text-red-600">{errMsg(mut.error)}</p>}
    </Modal>
  )
}

/* ---------------- Revoke invitation ---------------- */

function RevokeInviteModal({
  invite, onClose, onDone,
}: { invite: Invitation; onClose: () => void; onDone: () => void }) {
  const mut = useMutation({
    mutationFn: () => deleteInvitation(invite.id),
    onSuccess: () => {
      onDone()
      onClose()
    },
  })

  return (
    <Modal
      open
      title="Revoke invitation"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Revoking…' : 'Revoke'}
          </Button>
        </>
      }
    >
      <p>
        Revoke the invitation for <span className="font-semibold">{invite.email}</span>? They will no
        longer be able to join the portal with this invite.
      </p>
      {mut.isError && <p className="mt-2 text-sm text-red-600">{errMsg(mut.error)}</p>}
    </Modal>
  )
}
