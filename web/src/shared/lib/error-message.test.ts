import { expect, it } from 'vitest'
import { ApiError } from './api/http'
import { describeError } from './error-message'

const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? JSON.stringify(options) : ''}`

it('prefers the reason the server sent', () => {
  expect(describeError(new ApiError(403, 'the code is wrong', 'the code is wrong'), t)).toBe('the code is wrong')
})

it('falls back to a localized message for the status', () => {
  expect(describeError(new ApiError(404, 'HTTP 404', undefined), t)).toBe('errors.status.404{"status":404}')
  expect(describeError(new ApiError(502, 'HTTP 502', undefined), t)).toBe('errors.status.server{"status":502}')
  expect(describeError(new ApiError(418, 'HTTP 418', undefined), t)).toBe('errors.status.other{"status":418}')
})

it('uses the message of other errors', () => {
  expect(describeError(new Error('Failed to fetch'), t)).toBe('Failed to fetch')
  expect(describeError('boom', t)).toBe('errors.unknown')
})
