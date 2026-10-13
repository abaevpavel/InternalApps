import { requireSupabase } from '../lib/supabase'

/**
 * Обновления приложений портала (таблица `portal_releases`, миграция 0030).
 * Видны только портальной роли Developer (RLS); остальным запрос вернёт пусто.
 */
export interface Release {
  id: string
  appCode: string
  version: string
  releasedAt: string
  items: string[]
  /** details[n] — подробность к items[n]; может отсутствовать. */
  details: string[]
  pushedBy: string | null
  repo: string | null
  branch: string | null
  commitSha: string | null
}

export async function listReleases(): Promise<Release[]> {
  const { data, error } = await requireSupabase()
    .from('portal_releases')
    .select('id, app_code, version, released_at, items, details, pushed_by, repo, branch, commit_sha')
    .order('released_at', { ascending: false })
    .order('version', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    appCode: r.app_code as string,
    version: r.version as string,
    releasedAt: r.released_at as string,
    items: (r.items as string[] | null) ?? [],
    details: (r.details as string[] | null) ?? [],
    pushedBy: (r.pushed_by as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
  }))
}

/** Ссылка на коммит на GitHub, если известны репозиторий и коммит. */
export function commitUrl(r: Release): string | null {
  return r.repo && r.commitSha ? `https://github.com/${r.repo}/commit/${r.commitSha}` : null
}
