import { describe, expect, it } from 'vitest'
import { unescapeNewlines } from '../src/lib/utils'

describe('unescapeNewlines (BAS-1512)', () => {
  it('turns literal \\n into line breaks', () => {
    expect(unescapeNewlines('Deliver & Stage Drywall Sheets\\nMove 30 sheets')).toBe('Deliver & Stage Drywall Sheets\nMove 30 sheets')
  })
  it('handles \\r\\n and keeps real line breaks', () => {
    expect(unescapeNewlines('a\\r\\nb\nc')).toBe('a\nb\nc')
  })
  it('leaves plain text alone', () => {
    expect(unescapeNewlines('Install door')).toBe('Install door')
  })
})
