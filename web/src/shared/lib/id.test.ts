import { afterEach, describe, expect, it, vi } from 'vitest'
import { createId } from './id'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createId', () => {
  it('falls back to getRandomValues when randomUUID is missing (insecure context)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const ids = new Set(Array.from({ length: 100 }, () => createId()))
    expect(ids.size).toBe(100)
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('falls back to Math.random when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    const ids = new Set(Array.from({ length: 100 }, () => createId()))
    expect(ids.size).toBe(100)
  })

  it('uses randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'native-id' })
    expect(createId()).toBe('native-id')
  })
})
