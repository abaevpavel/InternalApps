import { supabase } from './supabase'

/**
 * Приём SSO-хэндоффа от портала.
 *
 * Портал (apps/portal/src/lib/sso.ts) кладёт сессию в URL-fragment:
 *   https://task-planner/…#sso=<base64 JSON {at, rt}>
 * Fragment выбран потому, что localStorage между origin'ами не шарится, а хэш
 * не уходит на сервер и не попадает в логи/Referer.
 *
 * Здесь мы обмениваем его на нормальную сессию Supabase и СРАЗУ вычищаем хэш,
 * чтобы токены не оставались в адресной строке и в истории вкладки.
 *
 * Модуль намеренно самодостаточный (единственная внешняя связь — supabase-клиент):
 * когда апок станет больше, его переносим в packages/lib без изменений.
 */
/**
 * Хэш снимаем СИНХРОННО на импорте модуля, до первого рендера роутера:
 * `<Route path="/" element={<Navigate to="/tasks" />}` успевает сменить URL раньше,
 * чем отработает эффект AuthProvider, и токены были бы потеряны.
 * Заодно сразу чистим адресную строку — даже если хэндофф окажется битым.
 */
const capturedHandoff: string | null = (() => {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  if (!hash.startsWith('#sso=')) return null
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return hash.slice('#sso='.length)
})()

export async function consumeSsoHandoff(): Promise<boolean> {
  const raw = capturedHandoff
  if (!raw) return false
  if (!supabase) return false

  try {
    const { at, rt } = JSON.parse(atob(decodeURIComponent(raw))) as { at?: string; rt?: string }
    if (!at || !rt) return false

    const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt })
    if (error) throw error
    return true
  } catch (e) {
    // Протухший/битый хэндофф — не падаем, просто уходим на обычный логин.
    console.warn('SSO handoff failed, falling back to sign-in:', e)
    return false
  }
}
