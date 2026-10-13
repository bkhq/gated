import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRateLimitCountdown } from './use-rate-limit-countdown'

describe('useRateLimitCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at the given retryAfter and ticks down to zero', () => {
    const { result } = renderHook(() => useRateLimitCountdown())

    expect(result.current.seconds).toBe(0)
    expect(result.current.active).toBe(false)

    act(() => {
      result.current.start(3)
    })
    expect(result.current.seconds).toBe(3)
    expect(result.current.active).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.seconds).toBe(2)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.seconds).toBe(1)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.seconds).toBe(0)
    expect(result.current.active).toBe(false)
  })

  it('clear() cancels an in-flight countdown', () => {
    const { result } = renderHook(() => useRateLimitCountdown())
    act(() => {
      result.current.start(5)
    })
    expect(result.current.seconds).toBe(5)

    act(() => {
      result.current.clear()
    })
    expect(result.current.seconds).toBe(0)
    expect(result.current.active).toBe(false)

    // After clear, the timer must not continue ticking — keep advancing time
    // and assert the value stays at 0.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.seconds).toBe(0)
  })

  it('start() while another countdown is active resets to the new value', () => {
    const { result } = renderHook(() => useRateLimitCountdown())
    act(() => {
      result.current.start(10)
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.seconds).toBe(7)

    act(() => {
      result.current.start(2)
    })
    expect(result.current.seconds).toBe(2)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current.seconds).toBe(0)
  })

  it('floors negative or zero retryAfter to 0', () => {
    const { result } = renderHook(() => useRateLimitCountdown())
    act(() => {
      result.current.start(-5)
    })
    expect(result.current.seconds).toBe(0)
    expect(result.current.active).toBe(false)
  })

  it('stops the interval when the component unmounts', () => {
    const { result, unmount } = renderHook(() => useRateLimitCountdown())
    act(() => {
      result.current.start(5)
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
