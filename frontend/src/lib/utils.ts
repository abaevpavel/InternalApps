import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Объединяет classnames с разрешением конфликтов Tailwind. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
