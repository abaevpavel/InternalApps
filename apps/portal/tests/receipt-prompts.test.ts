import { describe, expect, it } from 'vitest'
import { charLength, lengthHint, missingTokens, parseTokens, validatePrompt } from '../src/domain/receipt-prompts'

const meta = { minLen: 20, maxLen: 200, requiredTokens: ['we_paid', 'we_were_paid', 'neither'] }
const good = 'Answer with one of: we_paid, we_were_paid, neither. Be brief.'

describe('receipt-prompts', () => {
  it('accepts a text that keeps every token and fits the bounds', () => {
    expect(validatePrompt(good, meta)).toEqual([])
  })

  it('names the missing token', () => {
    const errs = validatePrompt(good.replace('we_were_paid', 'incoming'), meta)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('"we_were_paid"')
  })

  it('is case-sensitive: a renamed token is missing', () => {
    expect(missingTokens('We_Paid we_were_paid neither', meta.requiredTokens)).toEqual(['we_paid'])
  })

  it('enforces min and max length, and refuses blank text', () => {
    expect(validatePrompt('we_paid we_were_paid neither'.slice(0, 19), { ...meta, requiredTokens: [] })[0]).toMatch(/at least 20/)
    expect(validatePrompt('x'.repeat(201), { ...meta, requiredTokens: [] })[0]).toMatch(/limit is 200/)
    expect(validatePrompt('   \n ', meta)).toEqual(['The prompt cannot be empty.'])
  })

  it('parses tokens from text[] or jsonb, ignores junk', () => {
    expect(parseTokens(['a', 1, '', 'b'])).toEqual(['a', 'b'])
    expect(parseTokens(null)).toEqual([])
  })

  it('length hint', () => {
    expect(lengthHint('abc', { minLen: 1, maxLen: 10 })).toBe('3 characters · allowed 1–10')
    expect(lengthHint('abc', { minLen: null, maxLen: null })).toBe('3 characters')
  })

  it('tokens stored with quotes, as in the live catalogue', () => {
    const live = { minLen: null, maxLen: null, requiredTokens: ['money_direction', '"we_paid"'] }
    expect(validatePrompt('money_direction: "we_paid"', live)).toEqual([])
    const errs = validatePrompt('money_direction: we_paid', live)
    expect(errs[0]).toContain('mentions "we_paid".')
    expect(errs[0]).not.toContain('""')
  })

  it('counts characters like Postgres char_length', () => {
    expect(charLength('a😀b')).toBe(3)
  })
})
