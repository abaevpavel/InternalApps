/**
 * Группировка списка Portal Settings → Users по ролям.
 *
 * Порядок блоков: сначала приглашения (они ждут действия админа), затем роли в порядке
 * справочника ролей, «No role» — последним. У человека бывает несколько ролей (user_roles —
 * многие ко многим), такой человек показывается в каждом своём блоке: иначе, открыв блок
 * роли, админ не увидел бы всех, кому она выдана.
 */

export interface RoleRef {
  id: string
  name: string
}

export interface GroupableUser {
  roles: RoleRef[]
}

export interface UserGroup<U, I> {
  key: string
  label: string
  users: U[]
  invites: I[]
}

export const INVITES_GROUP = '__invites__'
export const NO_ROLE_GROUP = '__no_role__'

export function groupUsersByRole<U extends GroupableUser, I>(users: U[], invites: I[], roles: RoleRef[]): UserGroup<U, I>[] {
  const groups: UserGroup<U, I>[] = []

  if (invites.length) groups.push({ key: INVITES_GROUP, label: 'Pending invitations', users: [], invites })

  for (const role of roles) {
    const members = users.filter((u) => u.roles.some((r) => r.id === role.id))
    if (members.length) groups.push({ key: role.id, label: role.name, users: members, invites: [] })
  }

  // Роль, которой нет в справочнике (удалили, а связь осталась) — не теряем человека.
  const known = new Set(roles.map((r) => r.id))
  const orphanRoles = new Map<string, string>()
  for (const u of users) for (const r of u.roles) if (!known.has(r.id)) orphanRoles.set(r.id, r.name)
  for (const [id, name] of orphanRoles) {
    groups.push({ key: id, label: name, users: users.filter((u) => u.roles.some((r) => r.id === id)), invites: [] })
  }

  const noRole = users.filter((u) => u.roles.length === 0)
  if (noRole.length) groups.push({ key: NO_ROLE_GROUP, label: 'No role', users: noRole, invites: [] })

  return groups
}
