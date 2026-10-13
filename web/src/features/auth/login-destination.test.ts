import { describe, expect, it } from 'vitest'
import { loginDestination } from './login-destination'

describe('login return destination', () => {
  it('preserves local path and query', () => {
    expect(loginDestination('?next=%2Fapp%3Fx%3D1')).toBe('/app?x=1')
  })
  it('rejects off-origin and ambiguous destinations', () => {
    for (const next of ['https://example.com', '//example.com', '/\\example.com', '/%2fexample.com', '/x\nLocation: bad'])
      expect(loginDestination(`?next=${encodeURIComponent(next)}`)).toBe('/ui/')
  })
})
