import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminApi, setOnMfaSetupRequired, setOnUnauthorized, userApi } from './http'

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

describe('error messages', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it.each([
    ['a JSON string', JSON.stringify('name already exists'), 'name already exists'],
    ['plain text', 'Credential management is disabled', 'Credential management is disabled'],
    ['a message field', JSON.stringify({ message: 'bad input' }), 'bad input'],
    ['an error field', JSON.stringify({ error: 'invalid_request' }), 'invalid_request'],
    ['no body', '', 'HTTP 403'],
  ])('reads the reason from %s', async (_, body, message) => {
    globalThis.fetch = vi.fn(async () => new Response(body, { status: 403 }))
    await expect(adminApi.post('/x')).rejects.toThrow(message)
  })

  it('marks a 401 that ended the session', async () => {
    mockFetch(401, '')
    await expect(adminApi.get('/x')).rejects.toMatchObject({ sessionExpired: true })
  })
})

describe('http MFA setup callback', () => {
  afterEach(() => {
    setOnMfaSetupRequired(null)
    globalThis.fetch = originalFetch
  })

  it('fires when a response says the user still has to enroll', async () => {
    globalThis.fetch = vi.fn(async () => new Response('MFA setup required', {
      status: 403,
      headers: { 'x-gated-mfa-setup-required': '1' },
    }))
    const cb = vi.fn()
    setOnMfaSetupRequired(cb)
    await expect(userApi.get('/targets')).rejects.toThrow()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('stays quiet on any other 403', async () => {
    mockFetch(403, 'forbidden')
    const cb = vi.fn()
    setOnMfaSetupRequired(cb)
    await expect(userApi.get('/targets')).rejects.toThrow()
    expect(cb).not.toHaveBeenCalled()
  })
})
