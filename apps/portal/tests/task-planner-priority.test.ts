import { describe, expect, it } from 'vitest'
import { PRIORITY_RANK, toPriority } from '../src/domain/task-planner/priority'

/** BAS-1434: три значения приоритета и число для n8n «больше — важнее». */
describe('task priority', () => {
  it('keeps the three values as is', () => {
    expect(toPriority('high')).toBe('high')
    expect(toPriority('medium')).toBe('medium')
    expect(toPriority('low')).toBe('low')
  })

  it('maps the old 1–10 scale by the former badge bounds', () => {
    expect(toPriority(1)).toBe('high')
    expect(toPriority(3)).toBe('high')
    expect(toPriority(5)).toBe('medium')
    expect(toPriority(7)).toBe('low')
    expect(toPriority(10)).toBe('low')
  })

  it('defaults to medium', () => {
    expect(toPriority(null)).toBe('medium')
    expect(toPriority(undefined)).toBe('medium')
    expect(toPriority('urgent')).toBe('medium')
  })

  it('sends a bigger number for a more important task (as n8n reads it)', () => {
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.medium)
    expect(PRIORITY_RANK.medium).toBeGreaterThan(PRIORITY_RANK.low)
  })
})
