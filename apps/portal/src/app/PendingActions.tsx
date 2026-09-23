import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '../components/ui'
import { errMsg } from '../lib/utils'

/**
 * Подтверждение + 10 секунд на отмену для любой записи (Receipts Matcher, GMB Agent).
 *
 * Как устроено: после «да» запись НЕ уходит сразу — внизу экрана плашка «… in 10s · Undo», и
 * только когда время вышло, выполняется `run`. Undo — это отмена до записи, поэтому откатывать
 * нечего и она работает одинаково везде, в том числе для импорта, который после отправки
 * вернуть нельзя.
 *
 * Очередь живёт на уровне приложения, а не экрана: переключение вкладки не теряет отложенную
 * запись. Закрыть страницу, пока запись ждёт, — браузер спросит (иначе правка тихо пропала бы).
 */

export const UNDO_SECONDS = 10

export interface ConfirmSpec {
  title: string
  body: ReactNode
  cta: string
  danger?: boolean
}

export interface PendingSpec {
  /** Что произойдёт — в плашке: «Saving 2 changes», «Adding Chase 0034 to Oscar Herrera». */
  label: string
  run: () => Promise<unknown>
  /** Короткий итог после записи; по умолчанию «Saved». */
  doneLabel?: string
}

interface Item {
  id: number
  label: string
  doneLabel: string
  endsAt: number
  state: 'waiting' | 'running' | 'done' | 'error'
  error?: string
}

interface Ctx {
  /** Спросить и, если «да», поставить запись в очередь. Возвращает, было ли подтверждение. */
  confirmAndSchedule: (confirm: ConfirmSpec, pending: PendingSpec) => Promise<boolean>
  /** Есть ли отложенная запись — экраны блокируют повторное сохранение. */
  busy: boolean
}

const PendingContext = createContext<Ctx | null>(null)

export function usePendingActions(): Ctx {
  const ctx = useContext(PendingContext)
  if (!ctx) throw new Error('usePendingActions outside PendingActionsProvider')
  return ctx
}

export function PendingActionsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const [ask, setAsk] = useState<(ConfirmSpec & { resolve: (ok: boolean) => void }) | null>(null)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const runs = useRef(new Map<number, () => Promise<unknown>>())
  const nextId = useRef(1)
  const [, tick] = useState(0)

  const patch = (id: number, p: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)))
  const drop = (id: number) => setItems((list) => list.filter((i) => i.id !== id))

  const fire = useCallback(async (id: number) => {
    timers.current.delete(id)
    const run = runs.current.get(id)
    runs.current.delete(id)
    if (!run) return
    patch(id, { state: 'running' })
    try {
      await run()
      patch(id, { state: 'done' })
      setTimeout(() => drop(id), 2500)
    } catch (e) {
      // Ошибка висит, пока её не закроют: тихо пропавшая запись — худший исход.
      patch(id, { state: 'error', error: errMsg(e) })
    }
  }, [])

  const schedule = useCallback(
    (p: PendingSpec) => {
      const id = nextId.current++
      runs.current.set(id, p.run)
      setItems((list) => [
        ...list,
        { id, label: p.label, doneLabel: p.doneLabel ?? 'Saved', endsAt: Date.now() + UNDO_SECONDS * 1000, state: 'waiting' },
      ])
      timers.current.set(id, setTimeout(() => void fire(id), UNDO_SECONDS * 1000))
    },
    [fire],
  )

  const undo = (id: number) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    runs.current.delete(id)
    drop(id)
  }

  const confirmAndSchedule = useCallback(
    (confirm: ConfirmSpec, pending: PendingSpec) =>
      new Promise<boolean>((resolve) => {
        setAsk({
          ...confirm,
          resolve: (ok) => {
            setAsk(null)
            if (ok) schedule(pending)
            resolve(ok)
          },
        })
      }),
    [schedule],
  )

  const waiting = items.some((i) => i.state === 'waiting' || i.state === 'running')

  // Секундомер в плашке.
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [waiting])

  // Закрытие вкладки при отложенной записи — спросить браузером.
  useEffect(() => {
    if (!waiting) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [waiting])

  return (
    <PendingContext.Provider value={{ confirmAndSchedule, busy: waiting }}>
      {children}

      <Modal
        open={!!ask}
        title={ask?.title ?? ''}
        onClose={() => ask?.resolve(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => ask?.resolve(false)}>Cancel</Button>
            <Button variant={ask?.danger ? 'danger' : 'primary'} onClick={() => ask?.resolve(true)}>{ask?.cta}</Button>
          </>
        }
      >
        {ask?.body}
        <p className="mt-3 text-xs text-gray-400">You will have {UNDO_SECONDS} seconds to undo before anything is written.</p>
      </Modal>

      {items.length > 0 && (
        <div className="fixed bottom-20 left-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
          {items.map((i) => {
            const left = Math.max(0, Math.ceil((i.endsAt - Date.now()) / 1000))
            return (
              <div key={i.id} className="flex items-start gap-3 rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
                <div className="min-w-0 flex-1">
                  {i.state === 'waiting' && <span>{i.label} in {left}s…</span>}
                  {i.state === 'running' && <span>{i.label}…</span>}
                  {i.state === 'done' && <span className="text-green-300">{i.doneLabel} ✓</span>}
                  {i.state === 'error' && (
                    <span className="text-red-300">
                      Not saved — {i.label.toLowerCase()}: {i.error}
                    </span>
                  )}
                </div>
                {i.state === 'waiting' && (
                  <button type="button" className="shrink-0 font-semibold text-amber-300 hover:text-amber-200" onClick={() => undo(i.id)}>
                    Undo
                  </button>
                )}
                {i.state === 'error' && (
                  <button type="button" className="shrink-0 text-gray-300 hover:text-white" onClick={() => drop(i.id)}>
                    Dismiss
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </PendingContext.Provider>
  )
}
