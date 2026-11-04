import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TERMINAL_SETTINGS } from './terminal-settings'
import { TerminalSettingsDialog } from './terminal-settings-dialog'

describe('terminalSettingsDialog', () => {
  it('reports toggles, custom colors and a reset', () => {
    const onChange = vi.fn()
    render(<TerminalSettingsDialog open settings={{ ...DEFAULT_TERMINAL_SETTINGS, background: '#101010' }} onChange={onChange} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('switch', { name: 'terminal.settings.copyOnSelect' }))
    expect(onChange).toHaveBeenLastCalledWith({ copyOnSelect: true })

    fireEvent.change(screen.getByLabelText('terminal.settings.foreground'), { target: { value: '#00ff00' } })
    expect(onChange).toHaveBeenLastCalledWith({ foreground: '#00ff00' })

    fireEvent.click(screen.getByRole('button', { name: 'terminal.settings.resetColor' }))
    expect(onChange).toHaveBeenLastCalledWith({ background: null })

    fireEvent.click(screen.getByRole('button', { name: 'terminal.settings.reset' }))
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_TERMINAL_SETTINGS)
  })
})
