import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TargetStatusIndicator } from './target-status-indicator'

describe('targetStatusIndicator', () => {
  it('shows never-checked targets as unknown', () => {
    render(<TargetStatusIndicator status={null} />)
    expect(screen.getByText('targets.status.unknown')).toBeInTheDocument()
  })

  it('shows the latency of a reachable target', () => {
    render(<TargetStatusIndicator status={{ reachable: true, latencyMs: 12, error: null, checkedAt: '2026-11-05T00:00:00Z' }} />)
    expect(screen.getByText('targets.status.upLatency')).toBeInTheDocument()
  })

  it('shows the error of an unreachable target in its title', () => {
    render(<TargetStatusIndicator status={{ reachable: false, latencyMs: null, error: 'connection refused', checkedAt: '2026-11-05T00:00:00Z' }} />)
    const label = screen.getByText('targets.status.down')
    expect(label.parentElement?.getAttribute('title')).toMatch(/^connection refused · /)
  })
})
