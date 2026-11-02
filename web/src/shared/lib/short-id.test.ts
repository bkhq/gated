import { describe, expect, it } from 'vitest'
import { shortId } from './short-id'

describe('shortId', () => {
  it('keeps the first 8 characters of a UUID', () => {
    expect(shortId('3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b')).toBe('3f2b8c1e')
  })
  it('leaves short strings unchanged', () => {
    expect(shortId('abc')).toBe('abc')
    expect(shortId('123456789012')).toBe('123456789012')
  })
  it('truncates other long strings', () => {
    expect(shortId('abcdefghijklmnop')).toBe('abcdefgh…')
  })
})
