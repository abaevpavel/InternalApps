import { describe, expect, it } from 'vitest'
import {
  cardsOf, displayName, holderOf, lastSync, maskLast4, removesLastCard, validateIssuer, validateLast4, validateReason,
  type CardNumber, type Employee,
} from '../src/domain/receipt-cards'

const oscar: Employee = { id: 'e1', airtableRecordId: 'rec1', fullName: 'Oscar  Herrera ', email: null, active: true, syncedAt: '2026-09-20T10:00:00Z' }
const alfredo: Employee = { id: 'e2', airtableRecordId: 'rec2', fullName: 'Alfredo Lopez', email: null, active: true, syncedAt: '2026-09-22T10:00:00Z' }
const card = (p: Partial<CardNumber>): CardNumber => ({ id: 'c', kind: 'employee_card', last4: '0000', employeeId: 'e1', issuer: 'Chase', reason: null, active: true, ...p })

describe('receipt-cards', () => {
  it('last4 is text: four digits, leading zero kept', () => {
    expect(maskLast4('0034')).toBe('0034')
    expect(maskLast4('00-3 4x9')).toBe('0034')
    expect(validateLast4('0034')).toBeNull()
    expect(validateLast4('34')).not.toBeNull()
    expect(validateLast4('12345')).not.toBeNull()
  })

  it('display name is tidied for the screen only', () => {
    expect(displayName(oscar.fullName)).toBe('Oscar Herrera')
    expect(oscar.fullName).toBe('Oscar  Herrera ')
  })

  it('a duplicate names who holds the number', () => {
    const cards = [card({ id: 'c1', last4: '7999' }), card({ id: 'c2', kind: 'not_a_card', employeeId: null, issuer: null, last4: '7753', reason: 'Pepco account number' })]
    expect(holderOf('7999', cards, [oscar])).toBe('7999 is already on Oscar Herrera.')
    expect(holderOf('7753', cards, [oscar])).toMatch(/not a card \(Pepco account number\)/)
    expect(holderOf('7999', cards, [oscar], 'c1')).toBeNull()
    expect(holderOf('7999', [card({ last4: '7999', active: false })], [oscar])).toBeNull()
    const spare = card({ kind: 'shared_card', employeeId: null, last4: '2158', reason: 'spare' })
    expect(holderOf('2158', [spare], [oscar])).toBe('2158 is already the company’s shared card.')
  })

  it('removing the last active card in the whole table needs a confirmation', () => {
    const only = card({ id: 'c1' })
    expect(removesLastCard(only, [only, card({ id: 'c2', active: false })])).toBe(true)
    expect(removesLastCard(only, [only, card({ id: 'c3', employeeId: 'e2' })])).toBe(false)
    expect(removesLastCard(card({ kind: 'not_a_card' }), [card({ kind: 'not_a_card' })])).toBe(false)
  })

  it('issuer and reason are required', () => {
    expect(validateIssuer('  ')).not.toBeNull()
    expect(validateIssuer('Capital One')).toBeNull()
    expect(validateReason('')).not.toBeNull()
  })

  it('cards of a person, active first; last sync', () => {
    const list = cardsOf('e1', [card({ id: 'a', active: false, issuer: 'Amex' }), card({ id: 'b', issuer: 'BofA' }), card({ id: 'x', employeeId: 'e2' })])
    expect(list.map((c) => c.id)).toEqual(['b', 'a'])
    expect(lastSync([oscar, alfredo])).toBe('2026-09-22T10:00:00Z')
  })
})
