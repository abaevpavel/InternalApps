import { requireSupabase } from '../lib/supabase'

/**
 * Личные настройки интерфейса (BAS-1681, BAS-1628), таблица `user_preferences`
 * (миграция 0027). RLS: каждый читает и пишет только свою строку — ключ `auth.uid()`,
 * поэтому id берём из сессии, а не из профиля.
 */
export type HomeView = 'cards' | 'list'

/** { группа экрана: { id блока: открыт ли } } — только явные выборы человека. */
export type UiState = Record<string, Record<string, boolean>>

export interface Preferences {
  homeView: HomeView | null
  uiState: UiState
}

async function uid(): Promise<string | null> {
  const { data } = await requireSupabase().auth.getSession()
  return data.session?.user?.id ?? null
}

export async function getPreferences(): Promise<Preferences> {
  const id = await uid()
  if (!id) return { homeView: null, uiState: {} }
  const { data, error } = await requireSupabase()
    .from('user_preferences')
    .select('home_view, ui_state')
    .eq('user_id', id)
    .maybeSingle()
  if (error) throw error
  return {
    homeView: (data?.home_view as HomeView | undefined) ?? null,
    uiState: (data?.ui_state as UiState | undefined) ?? {},
  }
}

async function upsert(row: Record<string, unknown>): Promise<void> {
  const id = await uid()
  if (!id) return
  const { error } = await requireSupabase()
    .from('user_preferences')
    .upsert({ user_id: id, ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}

export async function saveHomeView(view: HomeView): Promise<void> {
  await upsert({ home_view: view })
}

/**
 * Записать состояние одной группы блоков. Остальные группы берём из базы, а не из
 * кэша экрана: человек мог свернуть что-то в другой вкладке.
 */
export async function saveGroupState(group: string, state: Record<string, boolean>): Promise<void> {
  const current = await getPreferences()
  await upsert({ ui_state: { ...current.uiState, [group]: state } })
}
