import { describe, expect, it } from 'vitest'
import { dayCategory, maxWorkingMinutes, overtimeLimitLabel, overtimeLimitOptions } from '../src/domain/task-planner/overtime'

describe('overtime limit per crew (BAS-1445)', () => {
  it('up to 8 hours is a normal day for any crew', () => {
    expect(dayCategory(480, 0)).toBe('normal')
    expect(dayCategory(300, 60)).toBe('normal')
  })
  it('within the crew limit is overtime, beyond it — over the limit', () => {
    expect(dayCategory(540, 60)).toBe('overtime_8_to_10')
    expect(dayCategory(541, 60)).toBe('overtime_over_10')
    expect(dayCategory(481, 0)).toBe('overtime_over_10')
  })
  it('without a limit falls back to the old rule of 10 hours', () => {
    expect(maxWorkingMinutes(undefined)).toBe(600)
    expect(dayCategory(600)).toBe('overtime_8_to_10')
    expect(dayCategory(601)).toBe('overtime_over_10')
  })
  it('labels and options', () => {
    expect(overtimeLimitLabel(0)).toBe('none')
    expect(overtimeLimitLabel(90)).toBe('+1h 30m')
    expect(overtimeLimitLabel(120)).toBe('+2h')
    expect(overtimeLimitOptions(45)).toContain(45)
    expect(overtimeLimitOptions()).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240])
  })
})
