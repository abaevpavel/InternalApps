/** Лёгкие UI-примитивы на Tailwind (без внешнего UI-кита). Стиль — светлый/воздушный. */
import {
  type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes,
  type ReactNode, type Key,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

/* ---------------- Button ---------------- */

type Variant = 'primary' | 'amber' | 'accent' | 'green' | 'blue' | 'danger' | 'ghost' | 'outline' | 'subtle'

const variants: Record<Variant, string> = {
  primary: 'bg-gray-900 text-white hover:bg-gray-800',
  amber: 'bg-brand-amber text-black hover:brightness-95',
  accent: 'bg-accent-600 text-white hover:bg-accent-700',
  green: 'bg-green-600 text-white hover:bg-green-700',
  blue: 'bg-blue-600 text-white hover:bg-blue-700',
  danger: 'bg-red-500 text-white hover:bg-red-600',
  ghost: 'bg-transparent text-gray-600 hover:bg-gray-100',
  outline: 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
  subtle: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
}

export function Button({
  variant = 'outline', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50',
        variants[variant], className,
      )}
      {...props}
    />
  )
}

/* ---------------- Surface ---------------- */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-gray-100 bg-white shadow-card', className)}>{children}</div>
}

/* ---------------- Form controls ---------------- */

const fieldBase =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-accent-500 focus:ring-1 focus:ring-accent-500 disabled:bg-gray-50 disabled:text-gray-400'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, className)} {...props} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(fieldBase, 'appearance-none pr-9', className)} {...props}>
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
    </div>
  )
}

/** Поле формы: подпись + контрол. */
export function Field({
  label, required, hint, children, className,
}: { label?: string; required?: boolean; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && (
        <label className="mb-1 block text-sm font-medium text-gray-700">
          {label} {required && <span className="text-accent-600">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}

/* ---------------- Badges ---------------- */

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', className)}>
      {children}
    </span>
  )
}

export type StatusTone = 'pending' | 'success' | 'danger' | 'neutral' | 'info' | 'warning'

const statusTones: Record<StatusTone, { wrap: string; dot: string }> = {
  pending: { wrap: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  success: { wrap: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
  danger: { wrap: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
  neutral: { wrap: 'bg-gray-100 text-gray-500', dot: 'bg-gray-400' },
  info: { wrap: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  warning: { wrap: 'bg-accent-50 text-accent-700', dot: 'bg-accent-500' },
}

/** Статус-пилюля с цветной точкой (как в референсе). */
export function StatusBadge({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  const t = statusTones[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide', t.wrap, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} />
      {children}
    </span>
  )
}

/* ---------------- Tabs (segmented control) ---------------- */

export function Tabs<T extends string>({
  tabs, value, onChange, className,
}: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('flex gap-1 rounded-lg bg-gray-100 p-1', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition',
            value === t.key ? 'bg-white text-gray-900 shadow-card' : 'text-gray-500 hover:text-gray-700',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Filter bar ---------------- */

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-gray-100 py-3', className)}>
      {children}
    </div>
  )
}

export function FilterControl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      {children}
    </div>
  )
}

/* ---------------- Data table (list) ---------------- */

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  className?: string
  align?: 'left' | 'right' | 'center'
}

export function DataTable<T>({
  columns, rows, getRowKey, onRowClick, empty,
}: {
  columns: Column<T>[]
  rows: T[]
  getRowKey: (row: T, i: number) => Key
  onRowClick?: (row: T) => void
  empty?: ReactNode
}) {
  const alignCls = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left'
  if (!rows.length) {
    return <div className="px-4 py-10 text-center text-sm text-gray-400">{empty ?? 'Nothing here yet.'}</div>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-100">
            {columns.map((c) => (
              <th key={c.key} className={cn('px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-400', alignCls(c.align), c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={getRowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn('border-b border-gray-100 last:border-0', onRowClick && 'cursor-pointer hover:bg-gray-50')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-4 py-4 align-middle text-sm text-gray-700', alignCls(c.align), c.className)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Двухстрочная ячейка таблицы: основной текст + подпись. */
export function Cell({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-semibold text-gray-900">{title}</div>
      {sub != null && <div className="truncate text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

/* ---------------- Modal ---------------- */

const modalSizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-3xl' }

export function Modal({
  open, title, subtitle, children, footer, onClose, size = 'md',
}: {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  size?: keyof typeof modalSizes
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className={cn('w-full rounded-xl bg-white shadow-xl', modalSizes[size])} onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
        </div>
        <div className="px-6 py-5 text-sm text-gray-600">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

/* ---------------- Page title ---------------- */

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
