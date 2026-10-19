import { describe, expect, it } from 'vitest'
import { AI_WAIT_MS, canDeleteTask, canEditTask, editableFields, isWaitingForAi } from '../src/domain/task-planner/edit-rules'
import type { Task } from '../src/domain/task-planner/types'

/** Правила правки и удаления по статусу (BAS-1514). */
const now = Date.parse('2026-10-19T15:00:00Z')
const task = (p: Partial<Task>): Task => ({ id: 'x', status: 'requested', execution_status: 'pending', ...p }) as Task

describe('canEditTask', () => {
  it('Requested, Proposed, Scheduled — yes', () => {
    expect(canEditTask(task({ status: 'requested' }), now)).toBe(true)
    expect(canEditTask(task({ status: 'proposed' }), now)).toBe(true)
    expect(canEditTask(task({ status: 'scheduled' }), now)).toBe(true)
  })

  it('Completed and Closed — no', () => {
    expect(canEditTask(task({ status: 'scheduled', execution_status: 'completed' }), now)).toBe(false)
    expect(canEditTask(task({ status: 'scheduled', execution_status: 'closed' }), now)).toBe(false)
  })

  it('waiting for the AI answer — no', () => {
    const sent = new Date(now - 60_000).toISOString()
    expect(canEditTask(task({ ai_request_id: 'r1', ai_sent_at: sent }), now)).toBe(false)
  })
})

describe('canDeleteTask', () => {
  it('only Requested', () => {
    expect(canDeleteTask(task({ status: 'requested' }), now)).toBe(true)
    expect(canDeleteTask(task({ status: 'proposed' }), now)).toBe(false)
    expect(canDeleteTask(task({ status: 'scheduled' }), now)).toBe(false)
  })

  it('not while waiting for the AI answer', () => {
    const sent = new Date(now - 60_000).toISOString()
    expect(canDeleteTask(task({ ai_request_id: 'r1', ai_sent_at: sent }), now)).toBe(false)
  })
})

describe('editableFields', () => {
  it('duration only in Requested — in Proposed/Scheduled the plan is not recalculated', () => {
    expect(editableFields(task({ status: 'requested' }))).toContain('duration')
    expect(editableFields(task({ status: 'proposed' }))).not.toContain('duration')
    expect(editableFields(task({ status: 'scheduled' }))).not.toContain('duration')
  })
})

describe('isWaitingForAi', () => {
  it('fresh mark — waiting; older than the wait time — not', () => {
    expect(isWaitingForAi({ ai_request_id: 'r1', ai_sent_at: new Date(now - 1000).toISOString() }, now)).toBe(true)
    expect(isWaitingForAi({ ai_request_id: 'r1', ai_sent_at: new Date(now - AI_WAIT_MS - 1000).toISOString() }, now)).toBe(false)
  })

  it('no mark — not waiting', () => {
    expect(isWaitingForAi({}, now)).toBe(false)
    expect(isWaitingForAi({ ai_request_id: 'r1', ai_sent_at: null }, now)).toBe(false)
  })
})
