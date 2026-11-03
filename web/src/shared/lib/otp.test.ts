import { expect, it } from 'vitest'
import { otpCode } from './otp'

it('keeps only the first six digits', () => {
  expect(otpCode(' 123 456 ')).toBe('123456')
  expect(otpCode('123-456-7')).toBe('123456')
  expect(otpCode('abc')).toBe('')
})
