import { requireSupabase } from '../lib/supabase'
import { errMsg } from '../lib/utils'

/**
 * «Живая» проверка ресурсов приложения с клиента (без service-role):
 *  - таблицы: реальный count строк (видимых под RLS) + флаг доступности;
 *  - бакеты: реальный список из Storage с public/private.
 * Edge-функции/внешние интеграции с клиента перечислить нельзя — остаются declared.
 */

export interface TableProbe {
  table: string
  count: number | null
  ok: boolean
  error?: string
}

export async function probeTables(tables: string[]): Promise<TableProbe[]> {
  if (!tables.length) return []
  const sb = requireSupabase()
  const results = await Promise.all(
    tables.map(async (table): Promise<TableProbe> => {
      try {
        const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true })
        if (error) return { table, count: null, ok: false, error: error.message }
        return { table, count: count ?? 0, ok: true }
      } catch (e) {
        return { table, count: null, ok: false, error: errMsg(e) }
      }
    }),
  )
  return results
}

export interface BucketInfo {
  name: string
  public: boolean
}

/** Реальный список бакетов Storage. null — если API недоступен под текущим ключом. */
export async function listBucketsSafe(): Promise<BucketInfo[] | null> {
  try {
    const sb = requireSupabase()
    const { data, error } = await sb.storage.listBuckets()
    if (error || !data) return null
    return data.map((b) => ({ name: b.name, public: !!(b as { public?: boolean }).public }))
  } catch {
    return null
  }
}
