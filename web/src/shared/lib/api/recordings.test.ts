import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import {
  getRecordingCastText,
  parseAsciiCast,
  recordingCastUrl,
  recordingStreamUrl,
  recordingTcpdumpUrl,
} from './recordings'

function mockTextResponse(status: number, text: string, statusText = ''): ReturnType<typeof vi.fn> {
  return vi.fn(async () => Promise.resolve(new Response(text, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })))
}

function firstCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls[0]
  if (call === undefined)
    throw new Error('fetch was not called')
  return [call[0] as string, (call[1] ?? {}) as RequestInit]
}

describe('recordingTcpdumpUrl', () => {
  it('builds the pcap download path with the id encoded', () => {
    expect(recordingTcpdumpUrl('abc-123')).toBe('/admin/api/recordings/abc-123/tcpdump')
    expect(recordingTcpdumpUrl('a/b c')).toBe('/admin/api/recordings/a%2Fb%20c/tcpdump')
  })
})

describe('recordingCastUrl', () => {
  it('builds the cast download path with the id encoded', () => {
    expect(recordingCastUrl('abc-123')).toBe('/admin/api/recordings/abc-123/cast')
    expect(recordingCastUrl('a/b c')).toBe('/admin/api/recordings/a%2Fb%20c/cast')
  })
})

describe('recordingStreamUrl', () => {
  it('builds the WS path with the id encoded', () => {
    expect(recordingStreamUrl('abc-123')).toBe('/admin/api/recordings/abc-123/stream')
    expect(recordingStreamUrl('a/b c')).toBe('/admin/api/recordings/a%2Fb%20c/stream')
  })
})

describe('parseAsciiCast', () => {
  it('splits on newline, drops empties, skips unparseable lines', () => {
    const text = [
      '{"version":2,"width":80,"height":24}',
      '[0.1,"o","hi"]',
      '',
      'not-json',
      '[0.2,"o","there"]',
    ].join('\n')
    expect(parseAsciiCast(text)).toEqual([
      { version: 2, width: 80, height: 24 },
      [0.1, 'o', 'hi'],
      [0.2, 'o', 'there'],
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseAsciiCast('')).toEqual([])
  })
})

describe('getRecordingCastText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the cast endpoint, encodes the id, and returns the raw text', async () => {
    const body = '{"version":2,"width":80,"height":24}\n[0.1,"o","hi"]\n'
    const fetchMock = mockTextResponse(200, body)
    vi.stubGlobal('fetch', fetchMock)

    const text = await getRecordingCastText('rec/1 2')

    expect(text).toBe(body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = firstCall(fetchMock)
    expect(calledUrl).toBe('/admin/api/recordings/rec%2F1%202/cast')
    expect(calledInit.credentials).toBe('include')
  })

  it('forwards the abort signal to fetch', async () => {
    const fetchMock = mockTextResponse(200, '')
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await getRecordingCastText('id', controller.signal)

    expect(firstCall(fetchMock)[1].signal).toBe(controller.signal)
  })

  it('throws ApiError carrying status and statusText on non-2xx', async () => {
    vi.stubGlobal('fetch', mockTextResponse(404, 'missing', 'Not Found'))
    await expect(getRecordingCastText('id')).rejects.toBeInstanceOf(ApiError)
    vi.stubGlobal('fetch', mockTextResponse(404, 'missing', 'Not Found'))
    await expect(getRecordingCastText('id')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Not Found',
    })
  })

  it('falls back to HTTP <status> when statusText is empty', async () => {
    vi.stubGlobal('fetch', mockTextResponse(500, 'oops', ''))
    await expect(getRecordingCastText('id')).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    })
  })
})
