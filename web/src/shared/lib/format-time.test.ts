import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatDateTime, formatFullDateTime, formatRelativeTime } from './format-time'

const originalTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai'
})
afterAll(() => {
  process.env.TZ = originalTz
})

const NANO = '2026-10-21T02:50:07.355643063Z'
const NOW = Date.parse('2026-10-21T03:00:00Z')

describe('formatDateTime', () => {
  it('parses nanosecond ISO strings into local time and omits the current year', () => {
    expect(formatDateTime(NANO, 'zh-CN', NOW)).toBe('10-21 10:50:07')
  })
  it('includes the year when it differs from the current year', () => {
    expect(formatDateTime('2025-01-02T00:00:00Z', 'zh-CN', NOW)).toBe('2025-01-02 08:00:00')
  })
  it('uses a localized month for English', () => {
    expect(formatDateTime(NANO, 'en', NOW)).toMatch(/^Oct 21, 10:50:07$/)
    expect(formatDateTime('2025-01-02T00:00:00Z', 'en', NOW)).toContain('2025')
  })
  it('returns invalid input unchanged', () => {
    expect(formatDateTime('not a date', 'zh-CN')).toBe('not a date')
    expect(formatDateTime('', 'en')).toBe('')
    expect(formatDateTime('2026-13-45T99:00:00Z', 'en')).toBe('2026-13-45T99:00:00Z')
  })
})

describe('formatFullDateTime', () => {
  it('includes the year, seconds and timezone offset', () => {
    const text = formatFullDateTime(NANO, 'zh-CN')
    expect(text).toContain('2026')
    expect(text).toContain('10:50:07')
    expect(text).toContain('GMT+08:00')
  })
  it('returns invalid input unchanged', () => {
    expect(formatFullDateTime('garbage', 'en')).toBe('garbage')
  })
})

describe('formatRelativeTime', () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  it('formats seconds, minutes, hours and days', () => {
    expect(formatRelativeTime(ago(10_000), 'en', NOW)).toBe('10 seconds ago')
    expect(formatRelativeTime(ago(3 * 60_000), 'en', NOW)).toBe('3 minutes ago')
    expect(formatRelativeTime(ago(3 * 60_000), 'zh-CN', NOW)).toBe('3分钟前')
    expect(formatRelativeTime(ago(5 * 3_600_000), 'en', NOW)).toBe('5 hours ago')
    expect(formatRelativeTime(ago(3 * 86_400_000), 'en', NOW)).toBe('3 days ago')
  })
  it('handles nanosecond input', () => {
    expect(formatRelativeTime(NANO, 'en', NOW)).toBe('10 minutes ago')
  })
  it('falls back to the absolute form beyond 7 days', () => {
    const iso = ago(8 * 86_400_000)
    expect(formatRelativeTime(iso, 'zh-CN', NOW)).toBe(formatDateTime(iso, 'zh-CN', NOW))
  })
  it('returns invalid input unchanged', () => {
    expect(formatRelativeTime('nope', 'en', NOW)).toBe('nope')
  })
})
