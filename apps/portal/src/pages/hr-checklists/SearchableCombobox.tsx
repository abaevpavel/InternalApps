import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface ComboOption {
  value: string
  label: string
  sub?: string
}

/** Поисковый комбобокс в стиле оригинала: кнопка → поповер с поиском и списком. */
export function SearchableCombobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  className,
  disabled,
}: {
  value: string | null
  onChange: (value: string) => void
  options: ComboOption[]
  placeholder?: string
  searchPlaceholder?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  const current = options.find((o) => o.value === value)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    return options.filter((o) => o.label.toLowerCase().includes(s) || (o.sub ?? '').toLowerCase().includes(s))
  }, [options, q])

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition hover:bg-gray-50',
          'focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className={cn('truncate', !current && 'text-gray-400')}>{current?.label ?? placeholder}</span>
        <ChevronDown size={15} className={cn('shrink-0 text-gray-400 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search size={15} className="text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
            />
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-3 py-3 text-sm text-gray-400">No matches</div>}
            {filtered.map((o) => {
              const selected = o.value === value
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-50',
                    selected && 'bg-accent-50',
                  )}
                >
                  <Check size={14} className={cn('mt-0.5 shrink-0', selected ? 'text-accent-600' : 'invisible')} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900">{o.label}</span>
                    {o.sub && <span className="block truncate text-xs text-gray-500">{o.sub}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
