import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, List } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { cn } from '../lib/utils'
import { getPreferences, saveGroupState, saveHomeView, type HomeView } from '../services/preferences'

/**
 * Вид экрана — карточки или список (BAS-1681). Выбор хранится за пользователем в базе
 * (`user_preferences`), поэтому одинаков на любом компьютере:
 *   • главная — колонка `home_view`;
 *   • остальные экраны — `ui_state["view.<экран>"] = { list: true|false }`.
 * Пока база не ответила, показываем последний выбор из этого браузера (кэш), чтобы вид
 * не мигал; если запись в базу не удалась — выбор всё равно работает в этом браузере.
 */
export type ViewMode = HomeView

export function useViewMode(screen: string): [ViewMode, (v: ViewMode) => void] {
  const { authUser } = useAuth()
  const qc = useQueryClient()
  const cacheKey = `portal.view.${screen}.${authUser?.id ?? 'anon'}`
  const cached = (): ViewMode => {
    try {
      return localStorage.getItem(cacheKey) === 'list' ? 'list' : 'cards'
    } catch {
      return 'cards'
    }
  }
  const q = useQuery({
    queryKey: ['user-preferences', authUser?.id ?? null],
    queryFn: getPreferences,
    enabled: !!authUser,
    retry: false,
    staleTime: 60_000,
  })
  const [local, setLocal] = useState<{ key: string; view: ViewMode } | null>(null)

  const fromDb: ViewMode | null =
    screen === 'home'
      ? q.data?.homeView ?? null
      : q.data?.uiState[`view.${screen}`]
        ? q.data.uiState[`view.${screen}`].list
          ? 'list'
          : 'cards'
        : null
  const view: ViewMode = local?.key === cacheKey ? local.view : fromDb ?? cached()

  const saveM = useMutation({
    mutationFn: (v: ViewMode) => (screen === 'home' ? saveHomeView(v) : saveGroupState(`view.${screen}`, { list: v === 'list' })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-preferences'] }),
  })

  const set = (v: ViewMode) => {
    setLocal({ key: cacheKey, view: v })
    try {
      localStorage.setItem(cacheKey, v)
    } catch {
      // не критично
    }
    saveM.mutate(v)
  }
  return [view, set]
}

export function ViewSwitch({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const item = (v: ViewMode, label: string, Icon: typeof List) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
        value === v ? 'bg-white text-gray-900 shadow-card' : 'text-gray-500 hover:text-gray-700',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  )
  return (
    <div className="inline-flex gap-1 rounded-lg bg-gray-100 p-1">
      {item('cards', 'Cards', LayoutGrid)}
      {item('list', 'List', List)}
    </div>
  )
}
