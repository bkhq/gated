import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deriveBannerStatus } from './terminal-status'
import { TerminalStatusBanner } from './terminal-status-banner'

describe('terminalStatusBanner', () => {
  it('renders the default label for each known status', () => {
    const cases: Array<[Parameters<typeof TerminalStatusBanner>[0]['status'], string]> = [
      ['connecting', 'Connecting…'],
      ['connected', 'Connected'],
      ['closed', 'Session closed'],
      ['error', 'Session error'],
      ['rate_limited', 'Rate limit reached'],
      ['info', 'Info'],
    ]
    for (const [status, label] of cases) {
      const { unmount } = render(<TerminalStatusBanner status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })

  it('uses the polite live region so screen readers announce changes', () => {
    render(<TerminalStatusBanner status="connecting" />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('data-status', 'connecting')
  })

  it('renders the server-supplied message after the status label', () => {
    render(<TerminalStatusBanner status="error" message="ssh: connection refused" />)
    expect(screen.getByText('Session error')).toBeInTheDocument()
    expect(screen.getByText('ssh: connection refused')).toBeInTheDocument()
  })

  it('omits the message slot when none is supplied', () => {
    render(<TerminalStatusBanner status="connected" />)
    expect(screen.queryByTitle('')).toBeNull()
  })

  it('honours overridden labels (i18n)', () => {
    render(
      <TerminalStatusBanner
        status="rate_limited"
        labels={{ rate_limited: '触发限流' }}
      />,
    )
    expect(screen.getByText('触发限流')).toBeInTheDocument()
  })

  it('tags the banner with a tone matching the status (for theming)', () => {
    const { rerender } = render(<TerminalStatusBanner status="error" />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'danger')
    rerender(<TerminalStatusBanner status="rate_limited" />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'warning')
    rerender(<TerminalStatusBanner status="connected" />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'success')
    rerender(<TerminalStatusBanner status="closed" />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'muted')
  })
})

describe('deriveBannerStatus', () => {
  it('prefers the last server status frame when it is known', () => {
    expect(
      deriveBannerStatus('open', { status: 'rate_limited', message: '' }),
    ).toBe('rate_limited')
    expect(
      deriveBannerStatus('closed', { status: 'error', message: 'x' }),
    ).toBe('error')
  })

  it('falls back to readyState=open → "connected"', () => {
    expect(deriveBannerStatus('open', null)).toBe('connected')
  })

  it('uses "connecting" when no status has arrived and the socket is not open', () => {
    expect(deriveBannerStatus('connecting', null)).toBe('connecting')
    expect(deriveBannerStatus('closed', null)).toBe('connecting')
  })

  it('ignores unknown server status strings and falls through', () => {
    expect(
      deriveBannerStatus('open', { status: 'something-new', message: '' }),
    ).toBe('connected')
  })
})
