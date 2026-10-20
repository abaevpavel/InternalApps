/**
 * Подтверждение и отмена для необратимых действий Task Planner — перенос и удаление задачи
 * (Vlad 20.10.2026): сначала «точно?», потом 5 секунд на Undo. Само действие уходит в базу только
 * по истечении этих секунд, поэтому Undo ничего не откатывает — оно просто отменяет отправку.
 * Если пользователь уходит со страницы раньше, отложенное действие выполняется сразу.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Undo2 } from 'lucide-react'
import { Button, Modal } from '../../components/task-planner-ui'

export const UNDO_MS = 5000

interface Pending {
  key: number
  label: string
  run: () => Promise<unknown>
  deadline: number
  timer: number
}

export function useUndoableAction(onError?: (e: unknown) => void, onDone?: () => void) {
  const [pending, setPending] = useState<Pending | null>(null)
  const ref = useRef<Pending | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const errRef = useRef(onError)
  const doneRef = useRef(onDone)
  errRef.current = onError
  doneRef.current = onDone

  const fire = useCallback((p: Pending) => {
    window.clearTimeout(p.timer)
    if (ref.current?.key === p.key) {
      ref.current = null
      setPending(null)
    }
    p.run().then(() => doneRef.current?.(), (e) => errRef.current?.(e))
  }, [])

  const schedule = useCallback((label: string, run: () => Promise<unknown>) => {
    if (ref.current) fire(ref.current) // предыдущее не ждёт — уходит сразу
    const key = Date.now() + Math.random()
    const p: Pending = { key, label, run, deadline: Date.now() + UNDO_MS, timer: 0 }
    p.timer = window.setTimeout(() => fire(p), UNDO_MS)
    ref.current = p
    setPending(p)
  }, [fire])

  const undo = useCallback(() => {
    if (!ref.current) return
    window.clearTimeout(ref.current.timer)
    ref.current = null
    setPending(null)
  }, [])

  // секундомер для обратного отсчёта на кнопке Undo
  useEffect(() => {
    if (!pending) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [pending])

  // ушли со страницы — отложенное действие не теряем
  useEffect(() => () => { if (ref.current) fire(ref.current) }, [fire])

  const left = pending ? Math.max(0, Math.ceil((pending.deadline - now) / 1000)) : 0
  const toast: ReactNode = pending ? (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-xl">
      <span>{pending.label}</span>
      <button type="button" onClick={undo}
        className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 font-semibold text-amber-300 hover:bg-white/20">
        <Undo2 size={14} /> Undo ({left}s)
      </button>
    </div>
  ) : null

  return { schedule, undo, toast, pendingLabel: pending?.label ?? null }
}

/** Простое «точно?» перед действием. */
export function ConfirmModal({ open, title, children, confirmLabel, danger = false, onCancel, onConfirm }: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      <div className="text-sm text-gray-600">{children}</div>
      <p className="mt-2 text-xs text-gray-400">You will have {UNDO_MS / 1000} seconds to undo.</p>
    </Modal>
  )
}
