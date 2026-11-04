import type { HostKeyVerifyPrompt, StatusPayload } from './codec'
import type { TerminalSocketReadyState, UseTerminalSocketOptions } from './use-terminal-socket'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalScreen } from './terminal-screen'
import { resetTerminalSettingsCache, updateTerminalSettings } from './terminal-settings'

const focusSpy = vi.fn()
const term: {
  written: string[]
  keyHandler: ((event: KeyboardEvent) => boolean) | null
  selectionHandler: (() => void) | null
  selection: string
  options: Record<string, unknown>
} = { written: [], keyHandler: null, selectionHandler: null, selection: '', options: {} }

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    modes = { applicationCursorKeysMode: false }
    options = term.options
    cols = 132
    rows = 41
    loadAddon() {}
    write(data: string) {
      term.written.push(data)
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      term.keyHandler = handler
    }

    onSelectionChange(handler: () => void) {
      term.selectionHandler = handler
      return { dispose() {} }
    }

    hasSelection() {
      return term.selection !== ''
    }

    getSelection() {
      return term.selection
    }

    open() {}
    focus() {
      focusSpy()
    }

    onData() {
      return { dispose() {} }
    }

    onResize() {
      return { dispose() {} }
    }

    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

vi.mock('@/shared/hooks/use-info', () => ({
  useInfo: () => ({ data: undefined }),
}))

const socketState: {
  readyState: TerminalSocketReadyState
  options: UseTerminalSocketOptions | null
} = { readyState: 'connecting', options: null }

const writeText = vi.fn(async () => {})
Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText: vi.fn(async () => '') }, configurable: true })

function resetTerm() {
  term.written = []
  term.keyHandler = null
  term.selectionHandler = null
  term.selection = ''
  term.options = {}
  writeText.mockClear()
  localStorage.clear()
  resetTerminalSettingsCache()
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
}

const stableSocket = {
  sendInput: vi.fn(),
  sendResize: vi.fn(),
  sendHostKeyDecision: vi.fn(),
}

vi.mock('./use-terminal-socket', () => ({
  useTerminalSocket: (options: UseTerminalSocketOptions) => {
    socketState.options = options
    return { ...stableSocket, readyState: socketState.readyState }
  },
}))

const connected: StatusPayload = { status: 'connected', message: '' }
const hostKeyPrompt: HostKeyVerifyPrompt = {
  algorithm: 'ssh-ed25519',
  keyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIBfakekey',
}

function renderScreen() {
  const view = render(<TerminalScreen kind="ssh" targetName="box" />)
  const rerender = () => view.rerender(<TerminalScreen kind="ssh" targetName="box" />)
  return { rerender }
}

describe('terminalScreen size', () => {
  beforeEach(() => {
    resetTerm()
    stableSocket.sendResize.mockClear()
    socketState.readyState = 'connecting'
    socketState.options = null
  })

  // The first fit happens before the socket opens and the gateway opens the
  // PTY at 80x24, so the size has to be sent once the session is connected.
  it('sends the terminal size when the session connects', () => {
    renderScreen()
    expect(stableSocket.sendResize).not.toHaveBeenCalled()
    socketState.readyState = 'open'
    act(() => socketState.options?.onStatus?.(connected))
    expect(stableSocket.sendResize).toHaveBeenCalledWith(132, 41)
  })
})

describe('terminalScreen auto-focus', () => {
  beforeEach(() => {
    focusSpy.mockClear()
    socketState.readyState = 'connecting'
    socketState.options = null
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
  })

  it('focuses the terminal exactly once when the session connects', () => {
    const { rerender } = renderScreen()
    expect(focusSpy).not.toHaveBeenCalled()

    socketState.readyState = 'open'
    act(() => socketState.options?.onStatus?.(connected))
    expect(focusSpy).toHaveBeenCalledTimes(1)

    rerender()
    act(() => socketState.options?.onStatus?.({ status: 'connected', message: 'again' }))
    expect(focusSpy).toHaveBeenCalledTimes(1)
  })

  it('does not focus while a host-key prompt is pending', () => {
    renderScreen()

    socketState.readyState = 'open'
    act(() => socketState.options?.onHostKeyVerify?.(hostKeyPrompt))
    act(() => socketState.options?.onStatus?.(connected))
    expect(focusSpy).not.toHaveBeenCalled()
  })
})

describe('terminalScreen experience', () => {
  beforeEach(() => {
    resetTerm()
    socketState.readyState = 'connecting'
    socketState.options = null
  })

  it('writes connection progress and the end reason into the terminal', () => {
    renderScreen()
    expect(term.written.join('')).toContain('terminal.progress.connecting')

    act(() => socketState.options?.onStatus?.({ status: 'error', message: 'Authentication failed' }))
    expect(term.written.at(-1)).toContain('Authentication failed')
  })

  it('offers reconnect and a new connection once the session ended', () => {
    const onNewConnection = vi.fn()
    render(<TerminalScreen kind="ssh" targetName="box" onNewConnection={onNewConnection} />)
    expect(screen.queryByRole('button', { name: 'terminal.actions.reconnect' })).toBeNull()

    act(() => socketState.options?.onStatus?.({ status: 'closed', message: 'SSH session ended' }))
    expect(screen.getAllByText('SSH session ended').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'terminal.actions.newConnection' }))
    expect(onNewConnection).toHaveBeenCalled()

    expect(socketState.options?.connectionId).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'terminal.actions.reconnect' }))
    expect(socketState.options?.connectionId).toBe(1)
    expect(screen.queryByRole('button', { name: 'terminal.actions.reconnect' })).toBeNull()
  })

  it('copies with Ctrl+Shift+C and leaves Ctrl+C to the shell', () => {
    renderScreen()
    term.selection = 'uptime'
    expect(term.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true)
    expect(writeText).not.toHaveBeenCalled()

    expect(term.keyHandler?.(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(writeText).toHaveBeenCalledWith('uptime')
  })

  it('copies on select only when enabled', () => {
    renderScreen()
    term.selection = 'hostname'
    act(() => term.selectionHandler?.())
    expect(writeText).not.toHaveBeenCalled()

    act(() => updateTerminalSettings({ copyOnSelect: true }))
    act(() => term.selectionHandler?.())
    expect(writeText).toHaveBeenCalledWith('hostname')
  })

  it('applies font zoom and theme changes live', () => {
    renderScreen()
    act(() => {
      term.keyHandler?.(new KeyboardEvent('keydown', { key: '=', ctrlKey: true }))
    })
    expect(term.options.fontSize).toBe(14)

    act(() => updateTerminalSettings({ theme: 'light' }))
    expect((term.options.theme as { background: string }).background).toBe('#ffffff')
  })
})
