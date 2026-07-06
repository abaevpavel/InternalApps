/**
 * Доменные типы портала — под РЕАЛЬНУЮ схему Lovable-Supabase (проект «HR DASHBOARD»).
 * Единственное место (вместе с services/data.ts), где живут имена таблиц/колонок.
 *
 * Модель ролей: many-to-many через `user_roles` (user_id → role_id). У юзера может
 * быть несколько ролей; доступ к приложению = объединение приложений всех его ролей.
 * «Admin» определяется по роли (см. roleIsAdmin).
 */

export interface Application {
  id: string
  name: string
  description: string | null
  /** Внешний URL приложения (субдомен). Null — ещё не задеплоено. */
  url: string | null
  icon: string | null
  created_at: string
}

export interface Role {
  id: string
  name: string
  description: string | null
  /** Массив/объект прав из Lovable; используется для детекта админа. */
  permissions: unknown
  created_at: string
  applications: Application[]
}

/** Лёгкая ссылка на роль (без списка приложений). */
export interface RoleRef {
  id: string
  name: string
  permissions: unknown
}

export interface Profile {
  id: string
  /** auth.users.id — ключ связи с user_roles. */
  user_id: string | null
  email: string
  first_name: string | null
  last_name: string | null
  created_at: string
  /** Роли юзера (из user_roles). */
  roles: RoleRef[]
}

/** Приглашение (Add User). Профиль создаётся из него при первом входе. */
export interface Invitation {
  id: string
  email: string
  role_ids: string[]
  created_at: string
  expires_at: string | null
  accepted_at: string | null
}

/** Полное имя из first/last (или пусто). */
export function fullName(p: { first_name: string | null; last_name: string | null }): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
}

/**
 * Админ ли роль. В Lovable нет флага is_admin — определяем по имени «Admin» либо по
 * маркерам в permissions (admin / manage_users / *). Устойчиво к формату permissions
 * (массив строк, объект флагов или строка).
 */
export function roleIsAdmin(role: { name: string; permissions: unknown }): boolean {
  if (role.name.trim().toLowerCase() === 'admin') return true
  const p = role.permissions
  const markers = ['admin', 'manage_users', 'all', '*']
  if (Array.isArray(p)) return p.some((x) => markers.includes(String(x).toLowerCase()))
  if (p && typeof p === 'object') {
    return Object.entries(p as Record<string, unknown>).some(
      ([k, v]) => markers.includes(k.toLowerCase()) && !!v,
    )
  }
  if (typeof p === 'string') return markers.some((m) => p.toLowerCase().includes(m))
  return false
}
