import { describe, expect, it } from 'vitest'
import { progressLine, statusDotClass } from './terminal-status'

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

describe('progressLine', () => {
  it('dims progress and colours end lines on a fresh line', () => {
    expect(progressLine('Connecting to box…', 'progress')).toBe('\x1B[2mConnecting to box…\x1B[0m\r\n')
    expect(progressLine('auth\nfailed', 'failed')).toBe('\r\n\x1B[31mauth failed\x1B[0m\r\n')
    expect(progressLine('closed', 'ended')).toContain('\x1B[33m')
  })
})
