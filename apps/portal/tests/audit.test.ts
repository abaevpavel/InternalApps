import { describe, expect, it } from 'vitest'
import { actorLabel, formatValue, recordLabel, shownFields, type AuditEntry } from '../src/domain/audit'

const base: AuditEntry = {
  id: 1, tableName: 'receipt_matcher_card_numbers', rowKey: 'uuid', action: 'update',
  oldData: { kind: 'employee_card', issuer: 'Chase', last4: '0034', active: true },
  newData: { kind: 'employee_card', issuer: 'Chase', last4: '0034', active: false },
  changedFields: ['active'], actorName: 'Helida Alvarenga', actorKind: 'person', changedAt: '2026-09-23T10:00:00Z',
}

describe('audit presentation', () => {
  it('names the record', () => {
    expect(recordLabel(base)).toBe('Chase 0034')
    expect(recordLabel({ ...base, newData: { kind: 'not_a_card', last4: '7753' } })).toBe('7753 (not a card)')
    expect(recordLabel({ ...base, tableName: 'receipt_matcher_employees', newData: { full_name: 'Oscar  Herrera ' } })).toBe('Oscar Herrera')
    expect(recordLabel({ ...base, tableName: 'gmb_settings', rowKey: 'notify_review_digest_to', newData: {} })).toBe('notify_review_digest_to')
  })
  it('labels automation by its Postgres role', () => {
    expect(actorLabel({ ...base, actorKind: 'automation', actorName: 'gmb_agent' })).toBe('GMB agent')
    expect(actorLabel({ ...base, actorKind: 'automation', actorName: 'service_role' })).toBe('Automation (sync)')
    expect(actorLabel(base)).toBe('Helida Alvarenga')
  })
  it('shows changed fields on update, meaningful fields on insert', () => {
    expect(shownFields(base)).toEqual(['active'])
    expect(shownFields({ ...base, action: 'insert', oldData: null, newData: { id: 'x', last4: '0034', reason: null } })).toEqual(['last4'])
  })
  it('truncates long values', () => {
    const v = formatValue('x'.repeat(200))
    expect(v.cut).toBe(true)
    expect(v.short.length).toBe(121)
    expect(formatValue(null).short).toBe('—')
  })
})
