import type {
  HttpProxyRecordingItem,
  Recording,
} from '@/shared/lib/api/recordings'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useHttpProxyRecording,
  useRecording,
  useRecordingCast,
  useSessionRecordings,
} from './use-recording-queries'

vi.mock('@/shared/lib/api/recordings', async () => {
  const actual = await vi.importActual<typeof import('@/shared/lib/api/recordings')>(
    '@/shared/lib/api/recordings',
  )
  return {
    ...actual,
    getRecording: vi.fn(),
    getSessionRecordings: vi.fn(),
    getHttpProxyRecording: vi.fn(),
    getRecordingCastText: vi.fn(),
  }
})

const api = await import('@/shared/lib/api/recordings')
const getRecordingMock = vi.mocked(api.getRecording)
const getSessionRecordingsMock = vi.mocked(api.getSessionRecordings)
const getHttpProxyRecordingMock = vi.mocked(api.getHttpProxyRecording)
const getRecordingCastTextMock = vi.mocked(api.getRecordingCastText)

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    name: 'rec-1',
    started: '2026-01-01T00:00:00Z',
    session_id: 'sess-1',
    kind: 'Terminal',
    metadata: '{}',
    ...overrides,
  }
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  })
}

function withClient(client: QueryClient): React.FC<{ children: React.ReactNode }> {
  return ({ children }) => React.createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useRecording', () => {
  it('does not fetch when id is undefined', () => {
    const client = newClient()
    renderHook(() => useRecording(undefined), { wrapper: withClient(client) })
    expect(getRecordingMock).not.toHaveBeenCalled()
  })

  it('fetches and caches under [recordings, one, id]', async () => {
    const rec = makeRecording({ id: 'rec-42' })
    getRecordingMock.mockResolvedValueOnce(rec)
    const client = newClient()

    const { result } = renderHook(() => useRecording('rec-42'), {
      wrapper: withClient(client),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(rec)
    expect(getRecordingMock).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['recordings', 'one', 'rec-42'])).toEqual(rec)
  })
})

describe('useSessionRecordings', () => {
  it('does not fetch when sessionId is undefined', () => {
    const client = newClient()
    renderHook(() => useSessionRecordings(undefined), { wrapper: withClient(client) })
    expect(getSessionRecordingsMock).not.toHaveBeenCalled()
  })

  it('fetches and caches under [recordings, session, sessionId]', async () => {
    const list = [makeRecording({ id: 'a' }), makeRecording({ id: 'b' })]
    getSessionRecordingsMock.mockResolvedValueOnce(list)
    const client = newClient()

    const { result } = renderHook(() => useSessionRecordings('sess-9'), {
      wrapper: withClient(client),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(list)
    expect(client.getQueryData(['recordings', 'session', 'sess-9'])).toEqual(list)
  })
})

describe('useHttpProxyRecording', () => {
  it('does not fetch when enabled is false', () => {
    const client = newClient()
    renderHook(() => useHttpProxyRecording('rec-1', false), {
      wrapper: withClient(client),
    })
    expect(getHttpProxyRecordingMock).not.toHaveBeenCalled()
  })

  it('does not fetch when id is undefined even if enabled', () => {
    const client = newClient()
    renderHook(() => useHttpProxyRecording(undefined, true), {
      wrapper: withClient(client),
    })
    expect(getHttpProxyRecordingMock).not.toHaveBeenCalled()
  })

  it('fetches when both id and enabled are set; caches under http-proxy key', async () => {
    const items: HttpProxyRecordingItem[] = [{
      timestamp: '2026-01-01T00:00:00Z',
      request_method: 'GET',
      request_path: '/foo',
      request_body: null,
      response_body: null,
    }]
    getHttpProxyRecordingMock.mockResolvedValueOnce(items)
    const client = newClient()

    const { result } = renderHook(() => useHttpProxyRecording('rec-7', true), {
      wrapper: withClient(client),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(items)
    expect(client.getQueryData(['recordings', 'http-proxy', 'rec-7'])).toEqual(items)
  })
})

describe('useRecordingCast', () => {
  it('does not fetch when enabled is false', () => {
    const client = newClient()
    renderHook(() => useRecordingCast('rec-1', false), {
      wrapper: withClient(client),
    })
    expect(getRecordingCastTextMock).not.toHaveBeenCalled()
  })

  it('does not fetch when id is undefined even if enabled', () => {
    const client = newClient()
    renderHook(() => useRecordingCast(undefined, true), {
      wrapper: withClient(client),
    })
    expect(getRecordingCastTextMock).not.toHaveBeenCalled()
  })

  it('fetches the cast text and parses it into AsciiCast lines', async () => {
    const text = [
      '{"version":2,"width":80,"height":24}',
      '[0.1,"o","hi"]',
      '[0.2,"o","there"]',
    ].join('\n')
    getRecordingCastTextMock.mockResolvedValueOnce(text)
    const client = newClient()

    const { result } = renderHook(() => useRecordingCast('rec-cast', true), {
      wrapper: withClient(client),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([
      { version: 2, width: 80, height: 24 },
      [0.1, 'o', 'hi'],
      [0.2, 'o', 'there'],
    ])
    expect(client.getQueryData(['recordings', 'cast', 'rec-cast'])).toBeDefined()
  })
})
