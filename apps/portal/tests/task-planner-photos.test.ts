import { describe, expect, it } from 'vitest'
import { isHeicFile } from '../src/lib/photoCompression'

// BAS-1442: HEIC с iPhone узнаём и по типу, и по имени (браузеры часто отдают пустой type).
describe('isHeicFile', () => {
  it('detects HEIC by type or name', () => {
    expect(isHeicFile({ type: 'image/heic', name: 'a.bin' })).toBe(true)
    expect(isHeicFile({ type: '', name: 'IMG_0001.HEIC' })).toBe(true)
    expect(isHeicFile({ type: 'image/heif-sequence', name: 'x' })).toBe(true)
    expect(isHeicFile({ type: 'image/jpeg', name: 'IMG_0001.jpg' })).toBe(false)
  })
})
