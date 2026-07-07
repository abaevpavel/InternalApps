import { useEffect, useRef, useState } from 'react'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import { Calendar as CalIcon, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { formatDateDisplay } from '../../services/sales'

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/** Компактный date-picker с поповер-календарём (date-fns, без внешних зависимостей). */
export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
}: {
  value: Date | null
  onChange: (d: Date | null) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState<Date>(value ?? new Date())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (value) setMonth(value)
  }, [value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(month)), end: endOfWeek(endOfMonth(month)) })

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition hover:bg-gray-50 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
      >
        <CalIcon size={15} className="shrink-0 text-gray-400" />
        <span className={cn('flex-1 truncate text-left', !value && 'text-gray-400')}>
          {value ? formatDateDisplay(value) : placeholder}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onChange(null)
            }}
            className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={14} />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={() => setMonth(subMonths(month, 1))} className="rounded p-1 text-gray-500 hover:bg-gray-100">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-gray-800">{format(month, 'MMMM yyyy')}</span>
            <button type="button" onClick={() => setMonth(addMonths(month, 1))} className="rounded p-1 text-gray-500 hover:bg-gray-100">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-gray-400">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((d) => {
              const selected = value && isSameDay(d, value)
              const inMonth = isSameMonth(d, month)
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  onClick={() => {
                    onChange(d)
                    setOpen(false)
                  }}
                  className={cn(
                    'h-8 rounded-md text-sm transition',
                    selected ? 'bg-accent-600 font-semibold text-white' : 'hover:bg-gray-100',
                    !inMonth && !selected && 'text-gray-300',
                    inMonth && !selected && 'text-gray-700',
                  )}
                >
                  {format(d, 'd')}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
