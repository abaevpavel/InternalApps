import { requireSupabase } from '../lib/supabase'

/**
 * Роли пользователей ВНУТРИ апки (таблица `app_user_roles`, миграция 0028, BAS-1509).
 * Доступ к апке даёт портальная роль; что человек может внутри — эти назначения.
 * Свои роли читает каждый, все и запись — админ портала (RLS).
 */

/** Роли текущего пользователя в апке. */
export async function listMyAppRoles(appCode: string, userId: string): Promise<string[]> {
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('app_user_roles')
    .select('role_key')
    .eq('app_code', appCode)
    .eq('user_id', userId)
  if (error) throw error
  return (data ?? []).map((r) => r.role_key as string)
}

/** Все назначения апки: user_id → его роли. */
export async function listAppRoleAssignments(appCode: string): Promise<Map<string, string[]>> {
  const sb = requireSupabase()
  const { data, error } = await sb.from('app_user_roles').select('user_id, role_key').eq('app_code', appCode)
  if (error) throw error
  const m = new Map<string, string[]>()
  for (const r of data ?? []) {
    const uid = r.user_id as string
    m.set(uid, [...(m.get(uid) ?? []), r.role_key as string])
  }
  return m
}

/**
 * Привести роли пользователя к набору `roles`: недостающие добавить, лишние снять.
 * Точечно, а не «удалить всё и вставить», — чтобы в истории (portal_audit_log)
 * остались только реальные изменения.
 */
export async function setUserAppRoles(appCode: string, userId: string, roles: string[], current: string[]): Promise<void> {
  const sb = requireSupabase()
  const toAdd = roles.filter((r) => !current.includes(r))
  const toRemove = current.filter((r) => !roles.includes(r))
  if (toRemove.length) {
    const { error } = await sb
      .from('app_user_roles')
      .delete()
      .eq('app_code', appCode)
      .eq('user_id', userId)
      .in('role_key', toRemove)
    if (error) throw error
  }
  if (toAdd.length) {
    const { data: auth } = await sb.auth.getUser()
    const rows = toAdd.map((role_key) => ({ app_code: appCode, user_id: userId, role_key, granted_by: auth.user?.id ?? null }))
    const { error } = await sb.from('app_user_roles').insert(rows)
    if (error) throw error
  }
}
