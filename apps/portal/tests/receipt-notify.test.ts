import { describe, expect, it } from 'vitest'
import {
  MAX_RECIPIENTS, duplicateEmails, emptyRecipient, normalizeRecipients, parseRecipients, sameRecipients, validateList, validateRecipient,
} from '../src/domain/receipt-notify'

const r = (name: string, email: string, phone = '') => ({ name, email, phone })

describe('receipt-notify validation', () => {
  it('accepts a normal entry and an empty phone', () => {
    expect(validateRecipient(r('Hélida Alvarenga', 'helida@basementremodeling.com'))).toEqual({})
    expect(validateRecipient(r('Pavel', 'pavel@basementremodeling.com', '+13015550123'))).toEqual({})
  })

  it('requires a name of at most 80 characters', () => {
    expect(validateRecipient(r('  ', 'a@b.co')).name).toBeDefined()
    expect(validateRecipient(r('x'.repeat(81), 'a@b.co')).name).toBeDefined()
  })

  it('refuses two addresses in one box', () => {
    expect(validateRecipient(r('A', 'a@b.co, c@d.co')).email).toMatch(/One address per row/)
    expect(validateRecipient(r('A', 'a@b.co;c@d.co')).email).toMatch(/One address per row/)
    expect(validateRecipient(r('A', 'a@b.co c@d.co')).email).toMatch(/One address per row/)
    expect(validateRecipient(r('A', 'not-an-email')).email).toBeDefined()
  })

  it('phone must be E.164', () => {
    expect(validateRecipient(r('A', 'a@b.co', '(301) 555-0123')).phone).toBeDefined()
    expect(validateRecipient(r('A', 'a@b.co', '13015550123')).phone).toBeDefined()
  })

  it('an empty list is valid; more than 20 is not', () => {
    expect(validateList([]).ok).toBe(true)
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => r(`P${i}`, `p${i}@b.co`))
    expect(validateList(many).ok).toBe(false)
    expect(validateList([emptyRecipient()]).ok).toBe(false)
  })
})

describe('receipt-notify shape', () => {
  it('normalizes: trims and stores an empty phone as null', () => {
    expect(normalizeRecipients([r(' A ', ' a@b.co ', ' ')])).toEqual([{ name: 'A', email: 'a@b.co', phone: null }])
  })
  it('parses junk without throwing', () => {
    expect(parseRecipients(null)).toEqual([])
    expect(parseRecipients([{ name: 'A', email: 'a@b.co', phone: null }, 7])).toEqual([r('A', 'a@b.co'), r('', '')])
  })
  it('flags duplicates case-insensitively and compares normalized lists', () => {
    expect([...duplicateEmails([r('A', 'A@b.co'), r('B', 'a@b.co ')])]).toEqual(['a@b.co'])
    expect(sameRecipients([r('A ', 'a@b.co')], [r('A', 'a@b.co')])).toBe(true)
  })
})
