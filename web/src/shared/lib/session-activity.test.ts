import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noteActivity } from './session-activity'

const reportActivity = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./api/auth', () => ({ reportActivity }))

beforeEach(() => {
  vi.useFakeTimers()
  reportActivity.mockClear()
})
afterEach(() => vi.useRealTimers())

it('reports activity at most once a minute', () => {
  vi.setSystemTime(10_000_000)
  noteActivity()
  noteActivity()
  expect(reportActivity).toHaveBeenCalledTimes(1)
  vi.setSystemTime(10_000_000 + 59_000)
  noteActivity()
  expect(reportActivity).toHaveBeenCalledTimes(1)
  vi.setSystemTime(10_000_000 + 60_000)
  noteActivity()
  expect(reportActivity).toHaveBeenCalledTimes(2)
})
