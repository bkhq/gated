import type { Recording } from '@/shared/lib/api/recordings'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...rest }: { to: string, children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}))

vi.mock('@/features/recordings/hooks/use-recording-queries', () => ({
  useRecording: vi.fn(),
}))

vi.mock('./terminal-player', () => ({
  TerminalPlayer: ({ recordingId, live }: { recordingId: string, live: boolean }) => (
    <div data-testid="stub-terminal" data-recording-id={recordingId} data-live={String(live)} />
  ),
}))
vi.mock('./traffic-player', () => ({
  TrafficPlayer: ({ recording }: { recording: Recording }) => (
    <div data-testid="stub-traffic" data-recording-id={recording.id} />
  ),
}))
vi.mock('./http-proxy-player', () => ({
  HttpProxyPlayer: ({ recordingId }: { recordingId: string }) => (
    <div data-testid="stub-http-proxy" data-recording-id={recordingId} />
  ),
}))
vi.mock('./sql-audit-player', () => ({
  SqlAuditPlayer: ({ recording }: { recording: Recording }) => (
    <div data-testid="stub-sql-audit" data-recording-id={recording.id} />
  ),
}))

const queries = await import('@/features/recordings/hooks/use-recording-queries')
const useRecording = vi.mocked(queries.useRecording)

const { RecordingPlayer } = await import('./recording-player')

interface QueryState {
  data?: Recording
  isPending: boolean
  isError: boolean
  error?: unknown
}

function queryResult(state: QueryState) {
  return state as unknown as ReturnType<typeof queries.useRecording>
}

function baseRecording(overrides: Partial<Recording>): Recording {
  return {
    id: 'rec-1',
    name: 'session-rec-1',
    started: '2026-05-31T12:00:00Z',
    ended: '2026-05-31T12:34:56Z',
    session_id: '00000000-0000-0000-0000-000000000001',
    kind: 'Terminal',
    metadata: '',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('recordingPlayer', () => {
  it('renders loading state while the query is pending', () => {
    useRecording.mockReturnValue(queryResult({ isPending: true, isError: false }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByText('recordings.dispatch.loading')).toBeInTheDocument()
  })

  it('renders the not-found state for a 404', () => {
    useRecording.mockReturnValue(queryResult({
      isPending: false,
      isError: true,
      error: new ApiError(404, 'Not Found', undefined),
    }))
    render(<RecordingPlayer recordingId="rec-missing" />)
    expect(screen.getByText('recordings.dispatch.notFound')).toBeInTheDocument()
    expect(screen.getByText('recordings.dispatch.notFoundHint')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'recordings.dispatch.backToSessions' })).toBeInTheDocument()
  })

  it('renders the not-found state for other errors too', () => {
    useRecording.mockReturnValue(queryResult({
      isPending: false,
      isError: true,
      error: new Error('boom'),
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByText('recordings.dispatch.notFound')).toBeInTheDocument()
  })

  it('dispatches Terminal recordings to TerminalPlayer with live=false when ended is set', () => {
    useRecording.mockReturnValue(queryResult({
      data: baseRecording({ kind: 'Terminal' }),
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    const stub = screen.getByTestId('stub-terminal')
    expect(stub).toBeInTheDocument()
    expect(stub.dataset.recordingId).toBe('rec-1')
    expect(stub.dataset.live).toBe('false')
  })

  it('passes live=true to TerminalPlayer when the recording has not ended', () => {
    const { ended: _ended, ...rest } = baseRecording({ kind: 'Terminal' })
    useRecording.mockReturnValue(queryResult({
      data: rest,
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByTestId('stub-terminal').dataset.live).toBe('true')
  })

  it('dispatches Traffic recordings to TrafficPlayer', () => {
    useRecording.mockReturnValue(queryResult({
      data: baseRecording({ kind: 'Traffic' }),
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByTestId('stub-traffic')).toBeInTheDocument()
  })

  it('dispatches HttpProxy recordings to HttpProxyPlayer', () => {
    useRecording.mockReturnValue(queryResult({
      data: baseRecording({ kind: 'HttpProxy' }),
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByTestId('stub-http-proxy')).toBeInTheDocument()
  })

  it('dispatches SqlAudit recordings to SqlAuditPlayer', () => {
    useRecording.mockReturnValue(queryResult({
      data: baseRecording({ kind: 'SqlAudit' }),
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByTestId('stub-sql-audit')).toBeInTheDocument()
  })

  it('links command audits to the command records surface', () => {
    useRecording.mockReturnValue(queryResult({ data: baseRecording({ kind: 'CommandAudit' }), isPending: false, isError: false }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByRole('link', { name: 'nav.adminCommandRecords' })).toHaveAttribute('href', '/admin/command-records')
  })

  it('renders the unknown-kind empty state for an unrecognised kind', () => {
    useRecording.mockReturnValue(queryResult({
      data: baseRecording({ kind: 'Mystery' as Recording['kind'] }),
      isPending: false,
      isError: false,
    }))
    render(<RecordingPlayer recordingId="rec-1" />)
    expect(screen.getByText('recordings.dispatch.unknownKind')).toBeInTheDocument()
  })
})
