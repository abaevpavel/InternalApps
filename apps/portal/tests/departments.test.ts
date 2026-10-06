import { describe, expect, it } from 'vitest'
import { displayAppName, groupByDepartment, NO_DEPARTMENT } from '../src/domain/departments'

/** BAS-1681: главная группирует апки по департаменту по возрастанию, без департамента — последним. */
describe('groupByDepartment', () => {
  const a = (name: string, department?: string | null) => ({ name, department })

  it('по возрастанию номера, «No department» последним', () => {
    const g = groupByDepartment([a('Offer', '02-SALES'), a('Free'), a('HR Checklists', '06-HR'), a('Sync', '06-HR'), a('Ads', '01-MARKETING')])
    expect(g.map((x) => x.label)).toEqual(['01-MARKETING', '02-SALES', '06-HR', NO_DEPARTMENT])
    expect(g[2].apps.map((x) => x.name)).toEqual(['HR Checklists', 'Sync'])
  })

  it('пустые департаменты не показываются, пустая строка = без департамента', () => {
    expect(groupByDepartment([a('X', ' '), a('Y', null)]).map((x) => x.label)).toEqual([NO_DEPARTMENT])
  })

  it('значение не из списка не теряется — перед «No department»', () => {
    const g = groupByDepartment([a('Z'), a('Q', '10-OTHER'), a('W', '08-IT')])
    expect(g.map((x) => x.label)).toEqual(['08-IT', '10-OTHER', NO_DEPARTMENT])
  })
})


describe('displayAppName — департамент префиксом', () => {
  it('префикс из департамента', () => {
    expect(displayAppName('Send an Offer Email', '02-SALES')).toBe('02-SALES — Send an Offer Email')
  })
  it('без департамента — просто имя', () => {
    expect(displayAppName(' Dev Apps ', null)).toBe('Dev Apps')
  })
  it('не дублирует, если имя уже начинается с департамента', () => {
    expect(displayAppName('06-HR Checklists', '06-HR')).toBe('06-HR Checklists')
  })
})
