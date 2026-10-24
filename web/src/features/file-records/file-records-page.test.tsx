import type { FileRecordsResponse } from '@/shared/lib/api/file-records'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatFullDateTime } from '@/shared/lib/format-time'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/features/file-records/hooks/use-file-records-queries', () => ({
  useFileRecords: vi.fn(),
}))

const hooks = await import('@/features/file-records/hooks/use-file-records-queries')
const useFileRecords = vi.mocked(hooks.useFileRecords)

const { FileRecordsPage } = await import('./file-records-page')

const RESPONSE: FileRecordsResponse = {
  items: [
    {
      timestamp: '2026-10-21T02:00:00Z',
      session_id: 'sess-1',
      target: 'web-1',
      target_id: null,
      user_id: null,
      username: 'alice',
      origin: 'sftp',
      operation: 'rename',
      path: '/tmp/a.txt',
      new_path: '/tmp/b.txt',
      bytes: null,
      success: false,
      error: 'Permission denied',
    },
  ],
  total: 1,
  offset: 0,
  limit: 50,
}

beforeEach(() => {
  vi.clearAllMocks()
  useFileRecords.mockReturnValue({ data: RESPONSE, isLoading: false } as unknown as ReturnType<typeof hooks.useFileRecords>)
})

describe('fileRecordsPage', () => {
  it('renders the rename destination and the failure', () => {
    render(<FileRecordsPage />)
    expect(screen.getByText('/tmp/a.txt → /tmp/b.txt')).toBeInTheDocument()
    expect(screen.getByText('fileRecords.origin.sftp')).toBeInTheDocument()
    expect(screen.getByTitle('Permission denied')).toBeInTheDocument()
  })

  it('passes the free-text query into the records query', () => {
    render(<FileRecordsPage />)
    fireEvent.change(screen.getByLabelText('fileRecords.searchPlaceholder'), { target: { value: 'tmp' } })
    expect(useFileRecords.mock.calls.at(-1)?.[0]).toMatchObject({ q: 'tmp', offset: 0, limit: 50 })
  })

  it('scopes the query to a fixed session and hides the session input', () => {
    render(<FileRecordsPage sessionId="sess-9" />)
    expect(useFileRecords.mock.calls.at(-1)?.[0]).toMatchObject({ session_id: 'sess-9' })
    expect(screen.queryByLabelText('fileRecords.fields.sessionId')).toBeNull()
    expect(screen.queryByText('actions.clearFilters')).toBeNull()
  })

  it('renders the timestamp with the full time on hover', () => {
    const { container } = render(<FileRecordsPage />)
    const time = container.querySelector('tbody time')
    expect(time).toHaveAttribute('dateTime', '2026-10-21T02:00:00Z')
    expect(time).toHaveAttribute('title', formatFullDateTime('2026-10-21T02:00:00Z', 'en'))
  })

  it('omits the page header when embedded', () => {
    render(<FileRecordsPage embedded />)
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })
})
