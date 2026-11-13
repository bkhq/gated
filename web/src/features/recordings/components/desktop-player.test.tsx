import type { DesktopRecordingItem } from '@/features/recordings/lib/desktop-recording'
import type { Recording } from '@/shared/lib/api/recordings'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopPlayer } from './desktop-player'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { text?: string }) => options?.text === undefined ? key : `${key}:${options.text}`,
  }),
}))

const recording: Recording = {
  id: 'rec-1',
  name: 'desktop',
  started: '2026-11-12T10:00:00Z',
  ended: '2026-11-12T10:05:00Z',
  session_id: 's-1',
  kind: 'Desktop',
  metadata: '{"type":"desktop"}',
}

const full = { x: 0, y: 0, width: 200, height: 100 }
const items: DesktopRecordingItem[] = [
  { type: 'resize', time: 0, width: 200, height: 100 },
  { type: 'png_image', time: 0, rect: full, keyframe: true, data: 'AA==' },
  { type: 'pointer_input', time: 1, x: 50, y: 25, buttons: 0 },
  { type: 'key_input', time: 2, keysym: 0x61, down: true },
  { type: 'key_input', time: 2.1, keysym: 0x61, down: false },
  { type: 'jpeg_image', time: 3, rect: { x: 10, y: 20, width: 4, height: 4 }, data: 'AA==' },
  { type: 'png_image', time: 12, rect: { x: 0, y: 0, width: 300, height: 150 }, keyframe: true, data: 'AA==' },
  { type: 'clipboard_input', time: 13, text: 'pasted text' },
  { type: 'scancode_input', time: 14, code: 0x1C, extended: false, down: true },
]

const drawn: unknown[][] = []

function respondWith(body: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
}

function renderPlayer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DesktopPlayer recording={recording} />
    </QueryClientProvider>,
  )
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function seekTo(time: number) {
  fireEvent.change(await screen.findByLabelText('recordings.desktop.seek'), { target: { value: String(time) } })
  await settle()
}

// Playback starts on its own; a test that asserts an exact position stops
// it first, or a slow machine has moved on by the time it looks.
async function pause() {
  fireEvent.click(await screen.findByRole('button', { name: 'recordings.desktop.pause' }))
}

function canvas(): HTMLCanvasElement {
  return screen.getByLabelText('recordings.desktop.canvas')
}

beforeEach(() => {
  drawn.length = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (...args: unknown[]) => drawn.push(args.slice(1)),
  } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: () => {} })))
  respondWith(items.map(item => JSON.stringify(item)).join('\n'))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('fetches the recording and shows its first frame', async () => {
  renderPlayer()
  await waitFor(() => expect(drawn).toEqual([[0, 0]]))
  expect(fetch).toHaveBeenCalledWith('/admin/api/recordings/rec-1/desktop', expect.anything())
  expect([canvas().width, canvas().height]).toEqual([200, 100])
  expect(screen.getByRole('link', { name: /recordings\.desktop\.download/ })).toHaveAttribute('download', 'desktop.jsonl')
})

it('draws up to the chosen time and marks the pointer and the keys', async () => {
  renderPlayer()
  await pause()
  await seekTo(5)
  expect(drawn).toEqual([[0, 0], [10, 20]])
  expect(screen.getByTestId('recorded-pointer')).toHaveStyle({ left: '25%', top: '25%' })
  expect(screen.getByText('a')).toBeInTheDocument()
  expect(screen.getByText('00:05 / 00:14')).toBeInTheDocument()
})

it('starts from the last keyframe when seeking past one', async () => {
  renderPlayer()
  await waitFor(() => expect(drawn).toEqual([[0, 0]]))
  await pause()
  drawn.length = 0
  await seekTo(14)
  // Only the keyframe at 12 s; the frames before it are skipped.
  expect(drawn).toEqual([[0, 0]])
  expect([canvas().width, canvas().height]).toEqual([300, 150])
  expect(screen.getByText('recordings.desktop.pasted:pasted text')).toBeInTheDocument()
  expect(screen.getByText('Enter')).toBeInTheDocument()
  expect(screen.queryByText('a')).not.toBeInTheDocument()
})

it('redraws from a keyframe when going back', async () => {
  renderPlayer()
  await pause()
  await seekTo(14)
  drawn.length = 0
  await seekTo(5)
  expect(drawn).toEqual([[0, 0], [10, 20]])
  expect([canvas().width, canvas().height]).toEqual([200, 100])
  expect(screen.queryByText('Enter')).not.toBeInTheDocument()
})

it('plays on its own and can be paused', async () => {
  renderPlayer()
  fireEvent.click(await screen.findByRole('button', { name: 'recordings.desktop.pause' }))
  expect(screen.getByRole('button', { name: 'recordings.desktop.play' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'recordings.desktop.play' }))
  expect(screen.getByRole('button', { name: 'recordings.desktop.pause' })).toBeInTheDocument()
})

it('stops at the end and starts over from there', async () => {
  renderPlayer()
  await seekTo(14)
  await screen.findByRole('button', { name: 'recordings.desktop.play' })
  drawn.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'recordings.desktop.play' }))
  await settle()
  expect(drawn).toEqual([[0, 0]])
  expect([canvas().width, canvas().height]).toEqual([200, 100])
})

it('cycles the playback speed', async () => {
  renderPlayer()
  const speed = await screen.findByRole('button', { name: 'recordings.desktop.speed' })
  expect(speed).toHaveTextContent('1×')
  fireEvent.click(speed)
  expect(speed).toHaveTextContent('2×')
})

it('says so when the recording is empty or cannot be loaded', async () => {
  respondWith('')
  renderPlayer()
  expect(await screen.findByText('recordings.desktop.empty')).toBeInTheDocument()

  cleanup()
  respondWith('', 404)
  renderPlayer()
  expect(await screen.findByText('recordings.desktop.error')).toBeInTheDocument()
})
