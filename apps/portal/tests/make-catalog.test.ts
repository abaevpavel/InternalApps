import { describe, expect, it } from 'vitest'
import { codeForApplication } from '../src/auth/useAppAccess'
import { makeVariables, previewHtml } from '../src/domain/make-catalog'

describe('make catalog', () => {
  it('lists Make variables once each', () => {
    expect(makeVariables('Hi {{1.client.first}}, total {{1.total}} — {{1.client.first}}')).toEqual(['{{1.client.first}}', '{{1.total}}'])
    expect(makeVariables('no vars')).toEqual([])
  })
  it('highlights variables in the preview', () => {
    const html = previewHtml('<p>Hi {{1.name}}</p>')
    expect(html).toContain('<mark')
    expect(html).toContain('{{1.name}}')
  })
  it('the /dev-apps row maps to the app', () => {
    expect(codeForApplication({ id: 'x', name: '', description: null, url: '/dev-apps', icon: null, created_at: '' })).toBe('dev-apps')
  })
})
