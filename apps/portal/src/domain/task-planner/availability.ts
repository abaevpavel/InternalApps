/**
 * Недоступность бригад (BAS-1446): отпуск, больничный и т. п. на период дат.
 * Бригада, недоступная в день планирования, в AI не уходит вовсе — портал убирает её из Teams
 * сам, n8n недоступных не получает (решение Vlad 22.10.2026: «зачем грузить ИИ»).
 * Задачу, назначенную такой бригаде, в AI не отправляем: сначала поменять бригаду или день.
 */
import type { TeamAvailability } from './types'

export const AVAILABILITY_KINDS = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'sick_leave', label: 'Sick leave' },
  { value: 'other', label: 'Other' },
] as const

export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number]['value']

export function toAvailabilityKind(v: unknown): AvailabilityKind {
  return AVAILABILITY_KINDS.some((k) => k.value === v) ? (v as AvailabilityKind) : 'other'
}

export function availabilityKindLabel(v: AvailabilityKind): string {
  return AVAILABILITY_KINDS.find((k) => k.value === v)?.label ?? 'Other'
}

type Period = Pick<TeamAvailability, 'team_id' | 'start_date' | 'end_date'>

/** Период действует в этот день (даты ISO YYYY-MM-DD, границы включительно). */
export function coversDate(p: Pick<Period, 'start_date' | 'end_date'>, date: string): boolean {
  return p.start_date <= date && date <= p.end_date
}

/** Период бригады, действующий в этот день, если есть. */
export function periodOn<P extends Period>(periods: P[], teamId: string | null | undefined, date: string | null | undefined): P | undefined {
  if (!teamId || !date) return undefined
  return periods.find((p) => p.team_id === teamId && coversDate(p, date))
}

/** id бригад, недоступных в этот день. */
export function teamsOffOn(periods: Period[], date: string): Set<string> {
  return new Set(periods.filter((p) => coversDate(p, date)).map((p) => p.team_id))
}

/** Бригады, которые можно отдать AI на этот день. */
export function availableTeamsOn<T extends { id: string }>(teams: T[], periods: Period[], date: string): T[] {
  const off = teamsOffOn(periods, date)
  return teams.filter((t) => !off.has(t.id))
}

/** Задачи, назначенные бригаде, недоступной в день задачи. */
export function tasksWithUnavailableTeam<T extends { assigned_team_id?: string | null; scheduled_date?: string | null }>(
  tasks: T[], periods: Period[],
): T[] {
  return tasks.filter((t) => !!periodOn(periods, t.assigned_team_id, t.scheduled_date))
}

/** Другой период этой же бригады, пересекающийся с [start, end] (кроме самого редактируемого). */
export function overlappingPeriod<P extends Period & { id: string }>(
  periods: P[], teamId: string, start: string, end: string, exceptId?: string | null,
): P | undefined {
  return periods.find((p) => p.id !== exceptId && p.team_id === teamId && p.start_date <= end && start <= p.end_date)
}

/** «Текущие и будущие» — ещё не закончились к этому дню; остальные — прошедшие. */
export function splitByDate<P extends Pick<Period, 'start_date' | 'end_date'>>(periods: P[], today: string): { upcoming: P[]; past: P[] } {
  const upcoming = periods.filter((p) => p.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))
  const past = periods.filter((p) => p.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date))
  return { upcoming, past }
}
