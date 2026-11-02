import { describe, expect, it } from 'vitest'
import { statusDotClass } from './terminal-status'

describe('statusDotClass', () => {
  it('colours the tab dot by connection status', () => {
    expect(statusDotClass('connected')).toContain('--success')
    expect(statusDotClass('error')).toBe('bg-destructive')
    expect(statusDotClass('rate_limited')).toBe('bg-destructive')
    expect(statusDotClass('connecting')).toBe('bg-muted-foreground/40')
    expect(statusDotClass('closed')).toBe('bg-muted-foreground/40')
    expect(statusDotClass(undefined)).toBe('bg-muted-foreground/40')
  })
})
