import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Card } from './ui'
import { cn } from '../lib/utils'
import { useAuth } from '../auth/AuthProvider'
import { getPreferences, saveGroupState } from '../services/preferences'

/**
 * Сворачиваемые блоки (BAS-1628): любая карточка-блок настроек сворачивается кнопкой
 * в заголовке. Что свёрнуто — помним за пользователем (см. CollapseGroup).
 *
 * Блоки одного экрана объединяются `CollapseGroup` — у группы свой ключ хранения и
 * кнопки «Collapse all / Expand all» (`CollapseAllControls`). Блок вне группы хранит
 * своё состояние сам по `storageKey`.
 */

function readMap(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : {}
    // Старый формат (массив свёрнутых id) — переводим в { id: false }.
    if (Array.isArray(parsed)) return Object.fromEntries(parsed.filter((x) => typeof x === 'string').map((id) => [id, false]))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeMap(key: string, value: Record<string, boolean>) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // не критично
  }
}

interface GroupCtx {
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  setAll: (open: boolean) => void
  register: (id: string) => () => void
  count: number
  collapsedCount: number
}

const Ctx = createContext<GroupCtx | null>(null)

/**
 * Группа блоков одного экрана. Состояние — только явные выборы человека
 * (`{ id: открыт ли }`); чего нет — берётся умолчание экрана (`defaultCollapsed`).
 *
 * Хранится за пользователем в базе (`user_preferences.ui_state`, миграция 0027) —
 * одинаково на любом компьютере. Копия в localStorage нужна, чтобы блоки не «прыгали»,
 * пока база не ответила, и чтобы всё работало, если запись в базу не удалась.
 */
export function CollapseGroup({
  storageKey,
  defaultCollapsed = false,
  children,
}: {
  storageKey: string
  defaultCollapsed?: boolean
  children: ReactNode
}) {
  const { authUser } = useAuth()
  const qc = useQueryClient()
  const cacheKey = `portal.collapsed.${storageKey}`
  const prefs = useQuery({
    queryKey: ['user-preferences', authUser?.id ?? null],
    queryFn: getPreferences,
    enabled: !!authUser,
    retry: false,
    staleTime: 60_000,
  })

  // Локальные правки этой сессии; пока их нет — база, пока нет базы — кэш браузера.
  const [local, setLocal] = useState<Record<string, boolean> | null>(null)
  const state: Record<string, boolean> = local ?? prefs.data?.uiState[storageKey] ?? readMap(cacheKey)

  // Блоки, которые сейчас на экране: «Collapse all» сворачивает только их.
  const ids = useRef(new Set<string>())
  const [count, setCount] = useState(0)

  const saveM = useMutation({
    mutationFn: (next: Record<string, boolean>) => saveGroupState(storageKey, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-preferences'] }),
  })
  const save = saveM.mutate

  const update = useCallback(
    (next: Record<string, boolean>) => {
      setLocal(next)
      writeMap(cacheKey, next)
      save(next)
    },
    [cacheKey, save],
  )

  // Стабильная ссылка: иначе каждый блок перерегистрировался бы на любое сворачивание.
  const register = useCallback((id: string) => {
    ids.current.add(id)
    setCount(ids.current.size)
    return () => {
      ids.current.delete(id)
      setCount(ids.current.size)
    }
  }, [])

  const value = useMemo<GroupCtx>(() => {
    const isOpen = (id: string) => (id in state ? state[id] : !defaultCollapsed)
    return {
      isOpen,
      toggle: (id) => update({ ...state, [id]: !isOpen(id) }),
      setAll: (open) => {
        const next = { ...state }
        for (const id of ids.current) next[id] = open
        update(next)
      },
      register,
      count,
      collapsedCount: [...ids.current].filter((id) => !isOpen(id)).length,
    }
  }, [state, defaultCollapsed, update, count, register])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** «Collapse all / Expand all» для блоков группы. Пока блоков меньше двух — не показываем. */
export function CollapseAllControls({ className }: { className?: string }) {
  const g = useContext(Ctx)
  if (!g || g.count < 2) return null
  const allCollapsed = g.collapsedCount === g.count
  return (
    <div className={cn('flex justify-end', className)}>
      <button
        type="button"
        onClick={() => g.setAll(allCollapsed)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
      >
        {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
        {allCollapsed ? 'Expand all' : 'Collapse all'}
      </button>
    </div>
  )
}

/** Состояние блока вне группы. */
function useStandalone(storageKey: string): [boolean, () => void] {
  const key = `portal.collapsed.${storageKey}`
  const [open, setOpen] = useState(() => readMap(key).self !== false)
  const toggle = () => {
    const next = !open
    setOpen(next)
    writeMap(key, { self: next })
  }
  return [open, toggle]
}

/**
 * Сворачиваемая карточка. `header` — содержимое заголовка (название, ключ, бейджи);
 * клик по всей строке заголовка сворачивает/разворачивает. `aside` — элементы справа
 * в заголовке, которые НЕ должны сворачивать по клику (кнопки и т.п.).
 */
export function CollapsibleCard({
  id,
  header,
  aside,
  children,
  className,
  bodyClassName = 'px-6 pb-6',
  headerClassName = 'px-6 py-4',
}: {
  id: string
  header: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  headerClassName?: string
}) {
  const g = useContext(Ctx)
  const [selfOpen, selfToggle] = useStandalone(id)
  const register = g?.register
  useEffect(() => (register ? register(id) : undefined), [register, id])

  const open = g ? g.isOpen(id) : selfOpen
  const toggle = g ? () => g.toggle(id) : selfToggle

  return (
    <Card className={className}>
      <div className={cn('flex items-start gap-2', headerClassName)}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {open ? (
            <ChevronDown size={16} className="mt-1 shrink-0 text-gray-400" />
          ) : (
            <ChevronRight size={16} className="mt-1 shrink-0 text-gray-400" />
          )}
          <div className="min-w-0 flex-1">{header}</div>
        </button>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </Card>
  )
}
