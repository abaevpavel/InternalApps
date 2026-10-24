import { cn } from '../lib/utils'

/**
 * Время в американском формате (9:30 AM) независимо от языка браузера. Встроенный
 * <input type="time"> показывает 24-часовой формат системы (у пользователей из России/Украины —
 * «14:30»), а Task Planner работает с американскими бригадами. Значение — как у нативного поля:
 * 'HH:MM' (24 ч) или '' — время не задано.
 */
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const STEP_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
const pad = (n: number) => String(n).padStart(2, '0')
// Обычный <select>: на телефоне открывает системный барабан, числа от языка не зависят.
// (Портальный Select с 10+ пунктами добавляет поиск — здесь он лишний.)
const SELECT = 'rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm text-gray-900 outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-500 disabled:bg-gray-50 disabled:text-gray-400'
function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(SELECT, className)} {...props} />
}

function parse(value: string): { h: number; m: number; pm: boolean } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!m) return null
  const h24 = Number(m[1])
  return { h: h24 % 12 === 0 ? 12 : h24 % 12, m: Number(m[2]), pm: h24 >= 12 }
}

function compose(h: number, m: number, pm: boolean): string {
  const h24 = (h % 12) + (pm ? 12 : 0)
  return `${pad(h24)}:${pad(m)}`
}

export function UsTimeInput({ value, onChange, disabled, className, allowEmpty = false }: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** Можно сбросить время (пункт «—»). */
  allowEmpty?: boolean
}) {
  const cur = parse(value)
  // пока время не задано, выбор любой части подставляет 9:00 AM в остальные
  const base = cur ?? { h: 9, m: 0, pm: false }
  // минуты не из шага 5 (например, 11:03 от AI) тоже показываем, чтобы значение не терялось
  const minutes = cur && !STEP_MINUTES.includes(cur.m) ? [...STEP_MINUTES, cur.m].sort((a, b) => a - b) : STEP_MINUTES

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Select className="w-[4.25rem]" disabled={disabled} aria-label="Hour"
        value={cur ? String(cur.h) : ''}
        onChange={(e) => {
          if (e.target.value === '') return onChange('')
          onChange(compose(Number(e.target.value), base.m, base.pm))
        }}>
        <option value="">{allowEmpty ? '—' : 'hh'}</option>
        {HOURS.map((h) => <option key={h} value={String(h)}>{h}</option>)}
      </Select>
      <span className="text-gray-400">:</span>
      <Select className="w-[4.25rem]" disabled={disabled} aria-label="Minutes"
        value={cur ? String(cur.m) : ''}
        onChange={(e) => { if (e.target.value !== '') onChange(compose(base.h, Number(e.target.value), base.pm)) }}>
        <option value="">mm</option>
        {minutes.map((m) => <option key={m} value={String(m)}>{pad(m)}</option>)}
      </Select>
      <Select className="w-[4.5rem]" disabled={disabled} aria-label="AM or PM"
        value={cur ? (cur.pm ? 'PM' : 'AM') : ''}
        onChange={(e) => { if (e.target.value !== '') onChange(compose(base.h, base.m, e.target.value === 'PM')) }}>
        <option value="">—</option>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </Select>
    </div>
  )
}
