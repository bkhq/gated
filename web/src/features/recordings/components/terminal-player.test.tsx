import type { UseRecordingStreamResult } from '@/features/recordings/hooks/use-recording-stream'
import type { AsciiCastLine } from '@/features/recordings/types'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the asciinema-player module — it ships WASM and won't initialise under
// jsdom. We just need to verify the player root mounts when data arrives.
const createMock = vi.fn((_src: unknown, _el: unknown, _opts?: unknown) => ({ dispose: vi.fn() }))
vi.mock('asciinema-player', () => ({ create: createMock }))
vi.mock('asciinema-player/dist/bundle/asciinema-player.css', () => ({}))

vi.mock('@/features/recordings/hooks/use-recording-queries', () => ({
  useRecordingCast: vi.fn(),
}))
vi.mock('@/features/recordings/hooks/use-recording-stream', () => ({
  useRecordingStream: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const hooks = await import('@/features/recordings/hooks/use-recording-queries')
const streamHooks = await import('@/features/recordings/hooks/use-recording-stream')
const useRecordingCast = vi.mocked(hooks.useRecordingCast)
const useRecordingStream = vi.mocked(streamHooks.useRecordingStream)

const { TerminalPlayer } = await import('./terminal-player')

interface CastQueryState {
  data?: AsciiCastLine[]
  isPending: boolean
  isError: boolean
}

function castResult(state: CastQueryState) {
  return state as unknown as ReturnType<typeof hooks.useRecordingCast>
}

function streamResult(state: Partial<UseRecordingStreamResult>): UseRecordingStreamResult {
  return {
    started: false,
    live: false,
    frames: [],
    ended: false,
    readyState: 'closed',
    lastError: null,
    ...state,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  createMock.mockReturnValue({ dispose: vi.fn() })
})

describe('terminalPlayer (static)', () => {
  it('renders loading state while the cast is pending', () => {
    useRecordingCast.mockReturnValue(castResult({ isPending: true, isError: false }))
    render(<TerminalPlayer recordingId="rec-1" live={false} />)
    expect(screen.getByText('recordings.terminal.loading')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('renders error state when the query errors', () => {
    useRecordingCast.mockReturnValue(castResult({ isPending: false, isError: true }))
    render(<TerminalPlayer recordingId="rec-1" live={false} />)
    expect(screen.getByText('recordings.terminal.error')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('renders the empty state when the cast has no frames', () => {
    useRecordingCast.mockReturnValue(castResult({ data: [], isPending: false, isError: false }))
    render(<TerminalPlayer recordingId="rec-1" live={false} />)
    expect(screen.getByText('recordings.terminal.empty')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('mounts the player root and calls createPlayer when data is present', () => {
    const cast: AsciiCastLine[] = [
      { version: 2, width: 80, height: 24 },
      [0.1, 'o', 'hello'],
    ]
    useRecordingCast.mockReturnValue(castResult({ data: cast, isPending: false, isError: false }))
    render(<TerminalPlayer recordingId="rec-1" live={false} />)
    expect(screen.getByTestId('terminal-player-root')).toBeInTheDocument()
    expect(createMock).toHaveBeenCalledTimes(1)
    const [src] = createMock.mock.calls[0]!
    expect(src).toEqual({ data: cast })
  })

  // Scaling to the container width blew an 80-column cast up to a huge font;
  // the player keeps the web terminal's size and scrolls instead.
  it('renders at the web terminal font size instead of scaling to the width', () => {
    useRecordingCast.mockReturnValue(castResult({ data: [{ version: 2, width: 80, height: 24 }], isPending: false, isError: false }))
    render(<TerminalPlayer recordingId="rec-1" live={false} />)
    const [, , opts] = createMock.mock.calls[0]!
    expect(opts).toMatchObject({ fit: false, terminalFontSize: '13px' })
    expect(screen.getByTestId('terminal-player-root')).toHaveClass('overflow-auto')
  })
})

describe('terminalPlayer (live)', () => {
  it('renders the waiting state until the stream starts', () => {
    useRecordingStream.mockReturnValue(streamResult({ started: false }))
    render(<TerminalPlayer recordingId="rec-1" live={true} />)
    expect(screen.getByText('recordings.terminal.live')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('renders the error state when the WebSocket errors before start', () => {
    useRecordingStream.mockReturnValue(streamResult({ started: false, lastError: new Event('error') }))
    render(<TerminalPlayer recordingId="rec-1" live={true} />)
    expect(screen.getByText('recordings.terminal.error')).toBeInTheDocument()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('mounts the player root and calls createPlayer once the stream has started', () => {
    useRecordingStream.mockReturnValue(streamResult({
      started: true,
      live: true,
      frames: [{ version: 2, width: 100, height: 30 }, [0.0, 'o', '$ ']],
    }))
    render(<TerminalPlayer recordingId="rec-1" live={true} />)
    const root = screen.getByTestId('terminal-player-root')
    expect(root).toBeInTheDocument()
    expect(root.dataset.live).toBe('true')
    expect(createMock).toHaveBeenCalledTimes(1)
    const [src] = createMock.mock.calls[0]!
    expect(typeof src).toBe('function')
  })
})
