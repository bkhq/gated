import { describe, expect, it } from 'vitest'
import { allowedExpiryValues, LONGEST_ALLOWED_PREFIX } from './expiry-options'

const PRESETS = ['30d', '90d', '365d', 'never']
const DAY = 86400

describe('allowedExpiryValues', () => {
  it('keeps every preset without a limit', () => {
    expect(allowedExpiryValues(PRESETS, null)).toEqual(PRESETS)
    expect(allowedExpiryValues(PRESETS, undefined)).toEqual(PRESETS)
  })

  it('drops presets at or beyond the limit and offers the longest allowed lifetime', () => {
    expect(allowedExpiryValues(PRESETS, 100 * DAY)).toEqual(['30d', '90d', `${LONGEST_ALLOWED_PREFIX}${100 * DAY - 60}s`])
    expect(allowedExpiryValues(PRESETS, 30 * DAY)).toEqual([`${LONGEST_ALLOWED_PREFIX}${30 * DAY - 60}s`])
    expect(allowedExpiryValues(PRESETS, 3600)).toEqual([`${LONGEST_ALLOWED_PREFIX}3540s`])
  })

  it('never offers a lifetime that is not in the future', () => {
    expect(allowedExpiryValues(PRESETS, 30)).toEqual([`${LONGEST_ALLOWED_PREFIX}30s`])
  })
})
