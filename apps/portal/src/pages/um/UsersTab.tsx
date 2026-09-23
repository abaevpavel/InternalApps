import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { KeyRound, MailX, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import {
  createInvitation, deleteInvitation, deleteUser, listPendingInvitations, listProfiles,
  listRoles, setUserPassword, setUserRoles, updateProfileName,
} from '../../services/data'
import { Badge, Button, Card, DataTable, Field, Input, Modal, Select, type Column } from '../../components/ui'
import { cn, errMsg, initials } from '../../lib/utils'
import { fullName, type Invitation, type Profile, type Role } from '../../domain/types'
import { useAuth } from '../../auth/AuthProvider'

type SortKey = 'name' | 'joined'

/** Строка списка — либо реальный юзер, либо ещё не принятое приглашение. */
type Row = { kind: 'user'; user: Profile } | { kind: 'invite'; invite: Invitation }

function inviteRoleNames(invite: Invitation, roles: Role[]): string[] {
  return invite.role_ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean) as string[]
}

/** Истёкшее приглашение уже не примется (см. `accept_invitation_for` в миграции 0010). */
function inviteExpired(invite: Invitation): boolean {
  return !!invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()
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
  const [pwdFor, setPwdFor] = useState<string | null>(null)

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
          const expired = inviteExpired(row.invite)
          return (
            <div className="flex items-center gap-3">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  expired ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {initials(null, row.invite.email)}
              </span>
              <Badge className={expired ? 'bg-gray-100 text-gray-500' : 'bg-amber-50 text-amber-700'}>
                {expired ? 'Expired' : 'Invited'}
              </Badge>
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
        // У приглашения роли ещё НЕ назначены: они лежат в `invitations.role_ids` и
        // попадут в `user_roles` только когда человек войдёт. Показываем их как
        // намерение, а не как действующую роль — иначе строка врёт (в БД ролей нет).
        if (row.kind === 'invite') {
          const names = inviteRoleNames(row.invite, roles)
          return (
            <span className="text-gray-400">
              {names.length ? `${names.join(', ')} — after first sign-in` : 'No role'}
            </span>
          )
        }
        const names = row.user.roles.map((r) => r.name)
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
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPwdFor(row.invite.email)}
              className="text-gray-400 hover:text-gray-700"
              aria-label="set password"
              title="Set password"
            >
              <KeyRound size={16} />
            </button>
            <button
              onClick={() => setRevoking(row.invite)}
              className="flex items-center gap-1 text-red-400 hover:text-red-600"
              aria-label="revoke invitation"
              title="Revoke invitation"
            >
              <MailX size={16} />
              <span className="text-xs">Revoke</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPwdFor(row.user.email)}
              className="text-gray-400 hover:text-gray-700"
              aria-label="set password"
              title="Set password"
            >
              <KeyRound size={16} />
            </button>
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
      {pwdFor && <SetPasswordModal email={pwdFor} onClose={() => setPwdFor(null)} onSaved={invalidate} />}
    </div>
  )
}

/* ---------------- Add User (invitation) ---------------- */

function AddUserModal({
  invitedBy, onClose, onSaved,
}: { invitedBy: string; onClose: () => void; onSaved: () => void }) {
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const [email, setEmail] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])

  const mut = useMutation({
    mutationFn: () =>
      createInvitation({ email, role_ids: roleIds, invited_by: invitedBy }),
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
        <Field label="Roles" hint="A user can have several roles — they get every app any of them grants.">
          <RoleChecklist roles={roles} value={roleIds} onChange={setRoleIds} />
        </Field>
        {mut.isError && <p className="text-sm text-red-600">{errMsg(mut.error)}</p>}
      </div>
    </Modal>
  )
}

/**
 * Несколько ролей у одного человека. Схема это всегда позволяла (`user_roles` — связь многие ко
 * многим), а доступ везде считается объединением: апка видна, если её даёт ХОТЯ БЫ одна роль
 * (`listUserApplications`, `user_has_application_access`, роли внутри апок через `some`).
 */
function RoleChecklist({
  roles, value, onChange, disabled,
}: { roles: Role[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  return (
    <div className={cn('max-h-56 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2', disabled && 'opacity-50')}>
      {roles.map((r) => {
        const on = value.includes(r.id)
        return (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={() => onChange(on ? value.filter((id) => id !== r.id) : [...value, r.id])}
            />
            <span className="text-gray-800">{r.name}</span>
          </label>
        )
      })}
      {roles.length === 0 && <p className="px-2 py-1 text-sm text-gray-400">No roles yet.</p>}
    </div>
  )
}

/* ---------------- Edit User (name + roles) ---------------- */

function EditUserModal({
  user, onClose, onSaved,
}: { user: Profile; onClose: () => void; onSaved: () => void }) {
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: listRoles })
  const [first, setFirst] = useState(user.first_name ?? '')
  const [last, setLast] = useState(user.last_name ?? '')
  const currentRoleIds = user.roles.map((r) => r.id)
  const [roleIds, setRoleIds] = useState<string[]>(currentRoleIds)
  const rolesChanged =
    roleIds.length !== currentRoleIds.length || roleIds.some((id) => !currentRoleIds.includes(id))

  const mut = useMutation({
    mutationFn: async () => {
      await updateProfileName(user.id, first.trim() || null, last.trim() || null)
      // Роли трогаем только если набор реально изменился. setUserRoles сам считает разницу:
      // добавляет недостающие и снимает лишние, не пересоздавая остальные.
      if (user.user_id && rolesChanged) {
        await setUserRoles(user.user_id, roleIds)
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
        <Field
          label="Roles"
          hint={user.user_id ? 'A user can have several roles — they get every app any of them grants.' : 'Roles can be set after the user first signs in.'}
        >
          <RoleChecklist roles={roles} value={roleIds} onChange={setRoleIds} disabled={!user.user_id} />
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

/* ---------------- Set password ---------------- */

/**
 * Выдать пароль вместо Google-входа. Нужно тем, кого Google не пускает: OAuth-клиент
 * портала Internal, и почта вне домена организации не войдёт в принципе.
 *
 * Письмо не уходит: аккаунт создаётся подтверждённым, пароль админ передаёт человеку сам.
 * Работает и для строки-приглашения — тогда аккаунт создастся заранее, а роли из
 * приглашения проставит триггер `on_auth_user_created_accept_invitation`.
 */
function SetPasswordModal({
  email, onClose, onSaved,
}: { email: string; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)

  const mut = useMutation({
    mutationFn: () => setUserPassword({ email, password }),
    onSuccess: () => {
      setDone(true)
      onSaved()
    },
  })

  const valid = password.length >= 8

  return (
    <Modal
      open
      title="Set password"
      subtitle={done ? undefined : 'The user will be able to sign in with email and password instead of Google.'}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="blue" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="blue" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Set password'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p>
          Password set for <span className="font-semibold">{email}</span>. Send it to them over a
          secure channel — it is not emailed automatically and cannot be viewed again here.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Email">
            <Input value={email} disabled />
          </Field>
          <Field label="New password" required hint="At least 8 characters. Not emailed — pass it on yourself.">
            <Input
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </Field>
          {mut.isError && <p className="text-sm text-red-600">{errMsg(mut.error)}</p>}
        </div>
      )}
    </Modal>
  )
}
