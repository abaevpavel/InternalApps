import { describe, expect, it } from 'vitest'
import snapshot from '../src/data/airtable-schema.json'
import { matchesField, typeLabel, type AirtableField, type AirtableSnapshot } from '../src/domain/airtable-schema'

const f = (p: Partial<AirtableField>): AirtableField => ({
  id: 'fld1', name: 'Full Name', type: 'formula', description: null, computed: true, primary: true, junk: false, ...p,
})

describe('airtable schema', () => {
  it('filters by input / computed / junk and searches formulas and options', () => {
    expect(matchesField(f({}), 'input', '')).toBe(false)
    expect(matchesField(f({}), 'computed', '')).toBe(true)
    expect(matchesField(f({ junk: true }), 'junk', '')).toBe(true)
    expect(matchesField(f({ formula: '{First Name} & " " & {Last Name}' }), 'all', 'last name')).toBe(true)
    expect(matchesField(f({ type: 'singleSelect', computed: false, choices: ['Booked', 'Sold'] }), 'all', 'sold')).toBe(true)
  })
  it('labels types', () => {
    expect(typeLabel('multipleLookupValues')).toBe('Lookup')
    expect(typeLabel('unknownType')).toBe('unknownType')
  })
  it('snapshot: core tables first, structure only', () => {
    const s = snapshot as AirtableSnapshot
    expect(s.bases.map((b) => b.name)).toEqual(['02-Sales', '03-Projects'])
    expect(s.bases[0].tables[0].name).toBe('Leads')
    expect(JSON.stringify(s)).not.toMatch(/"records"/)
  })
})
