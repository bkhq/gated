import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLockStatus,
  initEncryption,
  isRateLimited,
  unlockEncryption,
} from './encryption'
import { ApiError } from './http'

const originalFetch = globalThis.fetch

function mockFetch(status: number, body: unknown = '') {
  const fn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json' } },
    ),
  )
  globalThis.fetch = fn
  return fn
}

describe('encryption api client', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('getLockStatus', () => {
    it('returns the parsed payload with snake_case fields preserved', async () => {
      const fetchFn = mockFetch(200, { status: 'locked', db_ready: false, retry_after: null })
      const result = await getLockStatus()
      expect(result).toEqual({ status: 'locked', db_ready: false, retry_after: null })
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/admin/encryption/lock-status',
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('forwards an AbortSignal', async () => {
      const fetchFn = mockFetch(200, { status: 'disabled', db_ready: true })
      const controller = new AbortController()
      await getLockStatus(controller.signal)
      const init = fetchFn.mock.calls[0]?.[1]
      expect(init?.signal).toBe(controller.signal)
    })
  })

  describe('initEncryption', () => {
    it('posts the snake_case body verbatim', async () => {
      const fetchFn = mockFetch(201, { status: 'unlocked' })
      const result = await initEncryption({
        bootstrap_token: 'tok-123',
        master_password: 'pw',
      })
      expect(result).toEqual({ status: 'unlocked' })
      const call = fetchFn.mock.calls[0]
      expect(call?.[0]).toBe('/api/admin/encryption/init')
      const init = call?.[1]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({
        bootstrap_token: 'tok-123',
        master_password: 'pw',
      }))
    })
  })

  describe('unlockEncryption', () => {
    it('posts the snake_case body verbatim', async () => {
      const fetchFn = mockFetch(200, { status: 'unlocked' })
      const result = await unlockEncryption({ master_password: 'pw' })
      expect(result).toEqual({ status: 'unlocked' })
      const call = fetchFn.mock.calls[0]
      expect(call?.[0]).toBe('/api/admin/encryption/unlock')
      const init = call?.[1]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ master_password: 'pw' }))
    })
  })

  describe('isRateLimited', () => {
    it('returns true for a 429 ApiError with retry_after', () => {
      const err = new ApiError(429, 'Too many attempts', {
        code: 'rate_limited',
        message: 'Too many attempts',
        retry_after: 60,
      })
      expect(isRateLimited(err)).toBe(true)
      if (isRateLimited(err))
        expect(err.body.retry_after).toBe(60)
    })

    it('returns false for a non-429 ApiError', () => {
      const err = new ApiError(401, 'unauthorized', { message: 'unauthorized' })
      expect(isRateLimited(err)).toBe(false)
    })

    it('returns false for a 429 ApiError without rate_limited shape', () => {
      const err = new ApiError(429, 'limited', { message: 'limited' })
      expect(isRateLimited(err)).toBe(false)
    })

    it('returns false for a plain Error', () => {
      expect(isRateLimited(new Error('boom'))).toBe(false)
    })

    it('returns false for non-error values', () => {
      expect(isRateLimited(null)).toBe(false)
      expect(isRateLimited(undefined)).toBe(false)
      expect(isRateLimited('rate_limited')).toBe(false)
    })
  })
})
