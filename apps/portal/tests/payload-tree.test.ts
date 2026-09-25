import { describe, expect, it } from 'vitest'
import { buildPayloadTree, filterPayloadTree, type PayloadField } from '../src/domain/make-catalog'

const f = (path: string, p: Partial<PayloadField> = {}): PayloadField => ({
  path, type: null, example: null, usedIn: [], origin: 'app', unused: false, ...p,
})

describe('payload tree', () => {
  const fields = [
    f('action'),
    f('estimateResult.categories[].name', { unused: true }),
    f('estimateResult.categories[].subcategories[].total'),
    f('estimateResult.proposalId'),
    f('envelope_id', { origin: 'reference', missing: true }),
  ]
  it('keeps the JSON structure', () => {
    const t = buildPayloadTree(fields)
    expect(t.map((n) => n.key)).toEqual(['action', 'estimateResult', 'envelope_id'])
    const er = t[1]
    expect(er.children.map((n) => n.key)).toEqual(['categories[]', 'proposalId'])
    expect(er.children[0].children.map((n) => n.key)).toEqual(['name', 'subcategories[]'])
    expect(er.leaves).toBe(3)
    expect(er.unused).toBe(1)
  })
  it('filters to branches with matching fields', () => {
    const t = filterPayloadTree(buildPayloadTree(fields), (x) => x.unused)
    expect(t.map((n) => n.key)).toEqual(['estimateResult'])
    expect(t[0].children[0].children.map((n) => n.key)).toEqual(['name'])
  })
  it('counts missing', () => {
    expect(buildPayloadTree(fields).find((n) => n.key === 'envelope_id')?.missing).toBe(1)
  })
  it('merges `a` and `a[]` into one array node that keeps the path of its own field', () => {
    const t = buildPayloadTree([f('clientInfo'), f('clientInfo[].clientId'), f('clientInfo[].zip')])
    expect(t).toHaveLength(1)
    expect(t[0].key).toBe('clientInfo[]')
    expect(t[0].path).toBe('clientInfo')  // путь первого поля; пометка ищется и под clientInfo[]
    expect(t[0].children.map((n) => n.key)).toEqual(['clientId', 'zip'])
  })
})
