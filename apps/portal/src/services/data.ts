import { requireSupabase } from '../lib/supabase'
import type { Application, Invitation, Profile, Role, RoleRef } from '../domain/types'

/**
 * Сервисный слой портала под РЕАЛЬНУЮ схему Lovable (проект «HR DASHBOARD»,
 * pilxwhtkhysanpukaliu). Единственное место с именами таблиц/колонок.
 *
 * Связи (FK, подтверждены интроспекцией):
 *   user_roles(user_id, role_id)  →FK→ roles         (user_id = auth.users.id)
 *   role_applications(role_id, application_id) →FK→ roles, applications
 *   profiles(user_id) ↔ user_roles(user_id)  — БЕЗ FK, джойним в коде по user_id.
 *
 * RPC (подтверждены): user_has_admin_role(user_id uuid)→bool,
 *   delete_user_profile(user_uuid uuid)→bool.
 */

const ROLE_SELECT = '*, role_applications(application:applications(*))'

function sortApps(apps: Application[]): Application[] {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name))
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>()
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r)
  return [...seen.values()]
}

/* ---------------- Applications ---------------- */

export async function listApplications(): Promise<Application[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('applications').select('*')
  if (error) throw error
  return sortApps((data ?? []) as Application[])
}

/** Приложения, доступные юзеру = объединение приложений всех его ролей. */
export async function listUserApplications(userId: string): Promise<Application[]> {
  const sb = requireSupabase()
  const { data: ur, error: urErr } = await sb.from('user_roles').select('role_id').eq('user_id', userId)
  if (urErr) throw urErr
  const roleIds = (ur ?? []).map((r) => r.role_id as string)
  if (!roleIds.length) return []

  const { data, error } = await sb
    .from('role_applications')
    .select('application:applications(*)')
    .in('role_id', roleIds)
  if (error) throw error
  const apps = (data ?? []).map((r) => r.application as unknown as Application).filter(Boolean)
  return sortApps(dedupeById(apps))
}

/* ---------------- Roles ---------------- */

export async function listRoles(): Promise<Role[]> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('roles').select(ROLE_SELECT).order('created_at')
  if (error) throw error
  return (data ?? []).map((r) => {
    const { role_applications, ...rest } = r as Record<string, unknown>
    const apps = ((role_applications ?? []) as { application: Application }[])
      .map((x) => x.application)
      .filter(Boolean)
    return { ...(rest as unknown as Role), applications: sortApps(apps) }
  })
}

export async function createRole(input: { name: string; description: string; application_ids: string[] }): Promise<void> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('roles')
    .insert({ name: input.name.trim(), description: input.description.trim() || null })
    .select('id')
    .single()
  if (error) throw error
  await setRoleApplications(data.id as string, input.application_ids)
}

export async function updateRole(id: string, input: { name: string; description: string; application_ids: string[] }): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb
    .from('roles')
    .update({ name: input.name.trim(), description: input.description.trim() || null })
    .eq('id', id)
  if (error) throw error
  await setRoleApplications(id, input.application_ids)
}

async function setRoleApplications(roleId: string, applicationIds: string[]): Promise<void> {
  const sb = requireSupabase()
  const { error: delErr } = await sb.from('role_applications').delete().eq('role_id', roleId)
  if (delErr) throw delErr
  if (!applicationIds.length) return
  const rows = applicationIds.map((application_id) => ({ role_id: roleId, application_id }))
  const { error } = await sb.from('role_applications').insert(rows)
  if (error) throw error
}

export async function deleteRole(id: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('roles').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- Profiles (Users) ---------------- */

export async function listProfiles(): Promise<Profile[]> {
  const sb = requireSupabase()
  const [{ data: profiles, error: pErr }, { data: userRoles, error: urErr }] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('user_roles').select('user_id, role:roles(id, name, permissions)'),
  ])
  if (pErr) throw pErr
  if (urErr) throw urErr

  const rolesByUser = new Map<string, RoleRef[]>()
  for (const row of userRoles ?? []) {
    const uid = row.user_id as string
    const role = row.role as unknown as RoleRef | null
    if (!role) continue
    const list = rolesByUser.get(uid) ?? []
    list.push(role)
    rolesByUser.set(uid, list)
  }

  return (profiles ?? []).map((p) => ({
    ...(p as unknown as Omit<Profile, 'roles'>),
    roles: (p.user_id && rolesByUser.get(p.user_id as string)) || [],
  }))
}

/** Профиль текущего юзера по email (или user_id) + его роли. */
export async function getMyProfile(userId: string, email: string): Promise<Profile | null> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .or(`user_id.eq.${userId},email.ilike.${email}`)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const linkId = (data.user_id as string) ?? userId
  const { data: ur } = await sb.from('user_roles').select('role:roles(id, name, permissions)').eq('user_id', linkId)
  const roles = (ur ?? []).map((r) => r.role as unknown as RoleRef).filter(Boolean)
  return { ...(data as unknown as Omit<Profile, 'roles'>), roles }
}

export async function updateProfileName(id: string, first_name: string | null, last_name: string | null): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.from('profiles').update({ first_name, last_name }).eq('id', id)
  if (error) throw error
}

/**
 * Заменить роли юзера. Порядок «сначала добавить недостающие, потом удалить лишние» —
 * чтобы при сбое INSERT (например RLS) юзер не остался вообще без роли. Без допущений
 * об уникальном индексе: читаем текущие роли и вставляем только те, которых нет.
 */
export async function setUserRoles(userId: string, roleIds: string[]): Promise<void> {
  const sb = requireSupabase()
  const { data: existing, error: readErr } = await sb
    .from('user_roles')
    .select('role_id')
    .eq('user_id', userId)
  if (readErr) throw readErr
  const current = new Set((existing ?? []).map((r) => r.role_id as string))

  const toAdd = roleIds.filter((id) => !current.has(id))
  if (toAdd.length) {
    const { error } = await sb.from('user_roles').insert(toAdd.map((role_id) => ({ user_id: userId, role_id })))
    if (error) throw error
  }

  const toRemove = [...current].filter((id) => !roleIds.includes(id))
  if (toRemove.length) {
    const { error } = await sb.from('user_roles').delete().eq('user_id', userId).in('role_id', toRemove)
    if (error) throw error
  }
}

/** Удаление юзера — через Edge RPC (чистит profile + auth). */
export async function deleteUser(userId: string): Promise<void> {
  const sb = requireSupabase()
  const { error } = await sb.rpc('delete_user_profile', { user_uuid: userId })
  if (error) throw error
}

/* ---------------- Invitations (Add User) ---------------- */

/** Add User = приглашение: юзер появится в profiles при первом входе с этим email. */
export async function createInvitation(input: { email: string; role_ids: string[]; invited_by: string }): Promise<void> {
  const sb = requireSupabase()
  const token = crypto.randomUUID()
  const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await sb.from('invitations').insert({
    email: input.email.trim().toLowerCase(),
    role_ids: input.role_ids,
    token,
    invited_by: input.invited_by,
    expires_at,
  })
  if (error) throw error
}

/** Ещё не принятые приглашения (pending) — показываем в списке Users. */
export async function listPendingInvitations(): Promise<Invitation[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('invitations')
    .select('id, email, role_ids, created_at, expires_at, accepted_at')
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Invitation[]
}

/** Отозвать приглашение. `.select()` ловит тихий no-op при блокировке RLS на DELETE. */
export async function deleteInvitation(id: string): Promise<void> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('invitations').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error(
      'Nothing was deleted — DELETE likely blocked by RLS. Apply the "portal_admin_manage_invitations" policy in Supabase.',
    )
  }
}

/* ---------------- Auth helpers ---------------- */

export async function checkAdmin(userId: string): Promise<boolean> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('user_has_admin_role', { user_id: userId })
  if (error) return false
  return !!data
}
