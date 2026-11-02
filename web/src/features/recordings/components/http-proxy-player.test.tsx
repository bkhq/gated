import type { UseQueryResult } from '@tanstack/react-query'
import type { HttpProxyRecordingItem } from '@/shared/lib/api/recordings'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpProxyPlayer } from './http-proxy-player'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}))

vi.mock('../hooks/use-recording-queries', () => ({
  useHttpProxyRecording: vi.fn(),
}))

const hooks = await import('../hooks/use-recording-queries')
const useHttpProxyRecordingMock = vi.mocked(hooks.useHttpProxyRecording)

type Q = UseQueryResult<HttpProxyRecordingItem[]>

function mockQuery(overrides: Partial<Q>): void {
  useHttpProxyRecordingMock.mockReturnValue({
    data: undefined,
    error: null,
    isLoading: false,
    isError: false,
    isSuccess: false,
    isPending: false,
    isFetching: false,
    status: 'success',
    ...overrides,
  } as unknown as Q)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('httpProxyPlayer', () => {
  it('renders skeleton placeholders while loading', () => {
    mockQuery({ isLoading: true, isPending: true, status: 'pending' })
    render(<HttpProxyPlayer recordingId="rec-1" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(useHttpProxyRecordingMock).toHaveBeenCalledWith('rec-1', true)
  })

  it('shows the empty state when the recording has no exchanges', () => {
    mockQuery({ data: [], isSuccess: true, status: 'success' })
    render(<HttpProxyPlayer recordingId="rec-1" />)
    expect(screen.getByText('recordings.httpProxy.empty')).toBeInTheDocument()
  })

  it('surfaces the underlying error message when the query fails', () => {
    mockQuery({
      isError: true,
      error: new Error('boom: upstream offline'),
      status: 'error',
    })
    render(<HttpProxyPlayer recordingId="rec-1" />)
    expect(screen.getByText('boom: upstream offline')).toBeInTheDocument()
    expect(screen.queryByText('recordings.httpProxy.empty')).toBeNull()
  })

  it('renders one row per exchange with headers and a status badge', () => {
    const items: HttpProxyRecordingItem[] = [
      {
        timestamp: '2026-01-01T12:34:56Z',
        request_method: 'GET',
        request_path: '/api/v1/pods',
        request_body: null,
        response_status: 200,
        response_body: { items: [] },
      },
      {
        timestamp: '2026-01-01T12:35:10Z',
        request_method: 'POST',
        request_path: '/api/v1/login',
        request_body: { user: 'alice' },
        response_status: 503,
        response_body: 'upstream offline',
      },
    ]
    mockQuery({ data: items, isSuccess: true, status: 'success' })
    render(<HttpProxyPlayer recordingId="rec-1" />)

    expect(screen.getByText('recordings.httpProxy.headers.timestamp')).toBeInTheDocument()
    expect(screen.getByText('recordings.httpProxy.headers.method')).toBeInTheDocument()
    expect(screen.getByText('recordings.httpProxy.headers.path')).toBeInTheDocument()
    expect(screen.getByText('recordings.httpProxy.headers.status')).toBeInTheDocument()

    expect(screen.getByText('GET')).toBeInTheDocument()
    expect(screen.getByText('/api/v1/pods')).toBeInTheDocument()
    expect(screen.getByText('200')).toBeInTheDocument()

    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('/api/v1/login')).toBeInTheDocument()
    expect(screen.getByText('503')).toBeInTheDocument()
  })

  it('expands a row to reveal request and response bodies when toggled', async () => {
    const items: HttpProxyRecordingItem[] = [
      {
        timestamp: '2026-01-01T12:34:56Z',
        request_method: 'POST',
        request_path: '/api/v1/login',
        request_body: { user: 'alice' },
        response_status: 200,
        response_body: { token: 'abc' },
      },
    ]
    mockQuery({ data: items, isSuccess: true, status: 'success' })
    render(<HttpProxyPlayer recordingId="rec-1" />)

    expect(screen.queryByText('recordings.httpProxy.requestBody')).toBeNull()
    expect(screen.queryByText('recordings.httpProxy.responseBody')).toBeNull()

    const expandBtn = screen.getByRole('button', { name: 'recordings.httpProxy.expand' })
    fireEvent.click(expandBtn)

    expect(screen.getByText('recordings.httpProxy.requestBody')).toBeInTheDocument()
    expect(screen.getByText('recordings.httpProxy.responseBody')).toBeInTheDocument()
    expect(screen.getByText(/"user": "alice"/)).toBeInTheDocument()
    expect(screen.getByText(/"token": "abc"/)).toBeInTheDocument()

    const collapseBtn = screen.getByRole('button', { name: 'recordings.httpProxy.collapse' })
    fireEvent.click(collapseBtn)
    expect(screen.queryByText('recordings.httpProxy.requestBody')).toBeNull()
  })

  it('shows the bodyNone placeholder when a body is null', async () => {
    const items: HttpProxyRecordingItem[] = [
      {
        timestamp: '2026-01-01T12:34:56Z',
        request_method: 'GET',
        request_path: '/health',
        request_body: null,
        response_status: 204,
        response_body: null,
      },
    ]
    mockQuery({ data: items, isSuccess: true, status: 'success' })
    render(<HttpProxyPlayer recordingId="rec-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'recordings.httpProxy.expand' }))
    expect(screen.getAllByText('recordings.httpProxy.bodyNone')).toHaveLength(2)
  })
})
