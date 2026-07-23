import { describe, expect, it } from 'vitest'
import { codeForApplication } from '../src/auth/useAppAccess'
import type { Application } from '../src/domain/types'

function app(partial: Partial<Application>): Application {
  return {
    id: 'x',
    name: '',
    description: null,
    url: null,
    icon: null,
    created_at: '',
    ...partial,
  }
}

describe('codeForApplication — applications row → appRegistry code', () => {
  it('maps internal apps by relative url', () => {
    expect(codeForApplication(app({ url: '/production-checklist' }))).toBe('production-checklist')
    expect(codeForApplication(app({ url: '/checklists' }))).toBe('hr-checklists')
    expect(codeForApplication(app({ url: '/sales-email-sender' }))).toBe('sales')
    expect(codeForApplication(app({ url: '/buildertrend-schedule' }))).toBe('buildertrend-schedule')
    expect(codeForApplication(app({ url: '/hr-sync-airtable' }))).toBe('hr-sync')
    expect(codeForApplication(app({ url: '/gmail-auto-sender' }))).toBe('gmail-auto-sender')
  })

  it('maps Task Planner via relative url', () => {
    expect(codeForApplication(app({ url: '/task-planner' }))).toBe('task-planner')
  })

  it('maps Task Planner via absolute external url (pathname)', () => {
    expect(codeForApplication(app({ url: 'https://tp.example.com/task-planner' }))).toBe('task-planner')
  })

  it('falls back to name↔label when url has no usable pathname', () => {
    expect(
      codeForApplication(app({ url: 'http://localhost:5173', name: '01-Task Planner (Daly Schedule)' })),
    ).toBe('task-planner')
  })

  it('returns null for an unknown application', () => {
    expect(codeForApplication(app({ url: '/nope', name: 'Mystery' }))).toBeNull()
    expect(codeForApplication(app({ url: null, name: null as unknown as string }))).toBeNull()
  })
})
