import type { HostKeyVerifyPrompt, StatusPayload } from './codec'
import type { TerminalSocketReadyState, UseTerminalSocketOptions } from './use-terminal-socket'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalScreen } from './terminal-screen'

const focusSpy = vi.fn()

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    modes = { applicationCursorKeysMode: false }
    options = {}
    loadAddon() {}
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
