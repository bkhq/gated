import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { keySequence } from './key-sequence'
import { TerminalKeyMenu } from './terminal-key-menu'

describe('keySequence', () => {
  it('maps control keys to their bytes', () => {
    expect(keySequence('esc', false)).toBe('\x1B')
    expect(keySequence('tab', false)).toBe('\t')
    expect(keySequence('ctrl-c', false)).toBe('\x03')
    expect(keySequence('ctrl-d', false)).toBe('\x04')
    expect(keySequence('ctrl-z', false)).toBe('\x1A')
    expect(keySequence('ctrl-l', false)).toBe('\x0C')
  })

  it('follows the application cursor mode for arrows', () => {
    expect(keySequence('up', false)).toBe('\x1B[A')
    expect(keySequence('down', false)).toBe('\x1B[B')
    expect(keySequence('right', false)).toBe('\x1B[C')
    expect(keySequence('left', false)).toBe('\x1B[D')
    expect(keySequence('up', true)).toBe('\x1BOA')
    expect(keySequence('left', true)).toBe('\x1BOD')
  })
})

describe('terminalKeyMenu', () => {
  it('keeps the keys in a popover opened from the status bar', async () => {
    const onKey = vi.fn()
    render(<TerminalKeyMenu onKey={onKey} />)
    expect(screen.queryByRole('button', { name: 'Ctrl+C' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal keys' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Ctrl+C' }))
    fireEvent.click(screen.getByRole('button', { name: 'Up' }))
    expect(onKey).toHaveBeenNthCalledWith(1, 'ctrl-c')
    expect(onKey).toHaveBeenNthCalledWith(2, 'up')
    // Stays open for repeated presses.
    expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument()
  })

  it('uses overridden labels', async () => {
    render(<TerminalKeyMenu onKey={vi.fn()} labels={{ toolbar: '快捷键', up: '上' }} />)
    fireEvent.click(screen.getByRole('button', { name: '快捷键' }))
    expect(await screen.findByRole('button', { name: '上' })).toBeInTheDocument()
  })
})
