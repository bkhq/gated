import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TerminalWatermark } from './terminal-watermark'

describe('terminalWatermark', () => {
  it('renders nothing when disabled', () => {
    render(<TerminalWatermark enabled={false} username="alice" />)
    expect(screen.queryByTestId('terminal-watermark')).toBeNull()
  })

  it('renders the overlay when enabled', () => {
    render(<TerminalWatermark enabled username="alice" />)
    const overlay = screen.getByTestId('terminal-watermark')
    expect(overlay).toBeInTheDocument()
    // Overlay must never intercept pointer events over the terminal.
    expect(overlay).toHaveClass('pointer-events-none')
    expect(overlay).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows the operator identity in the tiles', () => {
    render(<TerminalWatermark enabled username="alice" />)
    const tiles = screen.getAllByText(/alice · /)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('falls back to a placeholder when username is null', () => {
    render(<TerminalWatermark enabled username={null} />)
    expect(screen.getAllByText(/unknown · /).length).toBeGreaterThan(0)
  })
})
