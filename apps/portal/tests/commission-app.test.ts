import { describe, expect, it } from 'vitest'
import {
  MAX_IDS,
  parseRecordIds,
  skipReason,
  summarize,
  type PayoutRecord,
} from '../src/domain/commission-app'

/**
 * BAS-1635: ссылка из письма billing'у несёт `ids` записей Clients Change Orders.
 * Подтверждать можно только то, что всё ещё в REQUESTED — повторный клик и подставленные
 * чужие id не должны ничего менять.
 */

const rec = (n: number) => `rec${String(n).padStart(14, 'A')}`

const co = (over: Partial<PayoutRecord>): PayoutRecord => ({
  id: rec(1),
  billingRecordId: 'C-CO-260518-98165',
  projectName: '26-04-08 Conelley-Sykesville, MD',
  requester: 'Shanae Mobley',
  pm: 'Gheorghe Caminschi',
  coTotal: 208,
  commission: 10.4,
  status: 'REQUESTED',
  ineligible: false,
  ...over,
})

describe('parseRecordIds — ids из ссылки письма', () => {
  it('берёт id через запятую, схлопывает дубли, сохраняет порядок', () => {
    const r = parseRecordIds(`${rec(2)},${rec(1)},${rec(2)}`)
    expect(r.ids).toEqual([rec(2), rec(1)])
    expect(r.invalid).toEqual([])
    expect(r.tooMany).toBe(false)
  })

  it('терпит пробелы и переносы, которые вставляют почтовики', () => {
    expect(parseRecordIds(` ${rec(1)} ,\n${rec(2)} `).ids).toEqual([rec(1), rec(2)])
  })

  it('мусор не теряет молча — отдаёт в invalid', () => {
    const r = parseRecordIds(`${rec(1)},recSHORT,'); DROP`)
    expect(r.ids).toEqual([rec(1)])
    expect(r.invalid).toEqual(['recSHORT', "');", 'DROP'])
  })

  it('пустая ссылка — пустой список', () => {
    expect(parseRecordIds(null)).toEqual({ ids: [], invalid: [], tooMany: false })
  })

  it('режет по лимиту и сообщает об этом', () => {
    const many = Array.from({ length: MAX_IDS + 3 }, (_, i) => rec(i + 1)).join(',')
    const r = parseRecordIds(many)
    expect(r.ids).toHaveLength(MAX_IDS)
    expect(r.tooMany).toBe(true)
  })
})

describe('summarize — что будет подтверждено', () => {
  it('в подтверждение идут только REQUESTED, сумма — только по ним', () => {
    const s = summarize([
      co({ id: rec(1), commission: 10.4 }),
      co({ id: rec(2), commission: 40, requester: 'Gheorghe Caminschi' }),
      co({ id: rec(3), commission: 99, status: 'PAID' }),
    ])
    expect(s.confirmable.map((r) => r.id)).toEqual([rec(1), rec(2)])
    expect(s.skipped.map((r) => r.id)).toEqual([rec(3)])
    expect(s.total).toBe(50.4)
    expect(s.requesters).toEqual(['Shanae Mobley', 'Gheorghe Caminschi'])
  })

  it('пустая комиссия считается нулём, сумма без хвостов float', () => {
    const s = summarize([co({ commission: 0.1 }), co({ id: rec(2), commission: 0.2 }), co({ id: rec(3), commission: null })])
    expect(s.total).toBe(0.3)
  })

  it('причина пропуска понятна человеку', () => {
    expect(skipReason(co({ status: 'PAID' }))).toBe('Already paid')
    expect(skipReason(co({ status: null }))).toBe('No commission status')
    expect(skipReason(co({ status: 'NOT PAID' }))).toBe('Status is NOT PAID, not REQUESTED')
  })
})
