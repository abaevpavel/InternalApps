import { describe, expect, it } from 'vitest'
import { buildSendPayload, type AnswerState } from '../src/services/production-checklist'
import type { ChecklistItem, ChecklistTemplate, Project } from '../src/domain/production-checklist'

/**
 * BUG-7: Send собирал тело запроса из кэша прогресса react-query, который после
 * проставления ответов не инвалидировался. Чеклист, заполненный в один заход, уезжал
 * в Make со всеми `selected_answer: null`, а проект при этом помечался Completed.
 * Тест фиксирует контракт: тело строится из состояния экрана (карта ответов).
 */

const project = { id: 'p1', name: 'Test project' } as Project
const template = { id: 't1', name: 'BASE PRICE CHECKLIST' } as ChecklistTemplate

const item = (task_id: string, label: string): ChecklistItem =>
  ({ id: `id-${task_id}`, task_id, label }) as ChecklistItem

const items = [item('q-drywall', 'Drywall finished?'), item('q-egress', 'Egress window installed?')]

describe('buildSendPayload — тело запроса на Make', () => {
  it('берёт ответы из карты экрана, а не из пустого прогресса', () => {
    const answers: Record<string, AnswerState> = {
      'q-drywall': { selected_answer: 'Yes', is_not_applicable: false, notes: 'level 4 finish' },
      'q-egress': { selected_answer: 'N/A', is_not_applicable: true, notes: null },
    }

    const payload = buildSendPayload({ project, template, items, answers })

    expect(payload.items).toEqual([
      {
        task_id: 'q-drywall',
        label: 'Drywall finished?',
        selected_answer: 'Yes',
        is_not_applicable: false,
        notes: 'level 4 finish',
      },
      {
        task_id: 'q-egress',
        label: 'Egress window installed?',
        selected_answer: 'N/A',
        is_not_applicable: true,
        notes: null,
      },
    ])
    expect(payload.payload_from).toBe('production-checklist')
    expect(payload.checklist?.name).toBe('BASE PRICE CHECKLIST')
  })

  it('пункт без ответа отдаётся пустым, а не пропускается', () => {
    const payload = buildSendPayload({ project, template, items, answers: {} })

    expect(payload.items).toHaveLength(2)
    expect(payload.items.every((i) => i.selected_answer === null && !i.is_not_applicable)).toBe(true)
  })

  it('сохраняет порядок пунктов шаблона', () => {
    const answers: Record<string, AnswerState> = {
      'q-egress': { selected_answer: 'No', is_not_applicable: false, notes: null },
    }

    const payload = buildSendPayload({ project, template, items, answers })

    expect(payload.items.map((i) => i.task_id)).toEqual(['q-drywall', 'q-egress'])
  })
})
