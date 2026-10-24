import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminApi, setOnUnauthorized, userApi } from './http'

const originalFetch = globalThis.fetch

function mockFetch(status: number, body: unknown = '') {
  const fn = vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
  ))
  globalThis.fetch = fn
  return fn
}

describe('http 401 unauthorized callback', () => {
  beforeEach(() => {
    setOnUnauthorized(null)
  })
  afterEach(() => {
    setOnUnauthorized(null)
    globalThis.fetch = originalFetch
  })

  it('fires on 401 from a non-auth endpoint', async () => {
    mockFetch(401, { message: 'expired' })
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(userApi.get('/info')).rejects.toThrow()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('does NOT fire on 401 from /api/auth/* (wrong-creds case)', async () => {
    mockFetch(401, { state: 'Failed' })
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(userApi.post('/auth/login', { username: 'x', password: 'y' })).rejects.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })

  it('does NOT fire on 401 from /api/sso/*', async () => {
    mockFetch(401)
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(userApi.get('/sso/providers')).rejects.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })

  it('fires on 401 from /admin/api/*', async () => {
    mockFetch(401)
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(adminApi.get('/users')).rejects.toThrow()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('does not fire on 2xx', async () => {
    mockFetch(200, { ok: true })
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await userApi.get('/info')
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('step-up 401 handling', () => {
  afterEach(() => {
    setOnUnauthorized(null)
    globalThis.fetch = originalFetch
  })

  it('does NOT fire on 401 from an account write (wrong confirmation)', async () => {
    mockFetch(401)
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(adminApi.put('/accounts/1', {})).rejects.toThrow()
    await expect(adminApi.post('/accounts/1/reveal', {})).rejects.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })

  it('still fires on 401 from an account read', async () => {
    mockFetch(401)
    const cb = vi.fn()
    setOnUnauthorized(cb)
    await expect(adminApi.get('/accounts')).rejects.toThrow()
    expect(cb).toHaveBeenCalledOnce()
  })
})
