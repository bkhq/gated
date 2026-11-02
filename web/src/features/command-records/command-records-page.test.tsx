import type { CommandRecordsResponse } from '@/shared/lib/api/command-records'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatFullDateTime } from '@/shared/lib/format-time'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/features/command-records/hooks/use-command-records-queries', () => ({
  useCommandRecords: vi.fn(),
}))

const hooks = await import('@/features/command-records/hooks/use-command-records-queries')
const useCommandRecords = vi.mocked(hooks.useCommandRecords)

const { CommandRecordsPage } = await import('./command-records-page')

const RESPONSE: CommandRecordsResponse = {
  items: [
    {
      source: 'shell',
      timestamp: '2026-07-01T10:00:00Z',
      session_id: 'sess-1',
      target: 'web-1',
      target_id: null,
      user_id: null,
      username: 'alice',
      command: 'sudo reboot',
      origin: 'exec',
      acl_action: 'deny',
      acl_rule_id: 3,
      acl_rule_name: 'no-reboot',
      outcome: 'blocked',
      success: null,
      error: null,
    },
  ],
  total: 1,
  offset: 0,
  limit: 50,
}

beforeEach(() => {
  vi.clearAllMocks()
  useCommandRecords.mockReturnValue({ data: RESPONSE, isLoading: false } as unknown as ReturnType<typeof hooks.useCommandRecords>)
})

describe('commandRecordsPage', () => {
  it('renders records with source and command text', () => {
    render(<CommandRecordsPage />)
    expect(screen.getByText('sudo reboot')).toBeInTheDocument()
    expect(screen.getByText('commandRecords.source.shell')).toBeInTheDocument()
  })

  it('passes the free-text query into the records query', () => {
    render(<CommandRecordsPage />)
    const search = screen.getByLabelText('commandRecords.searchPlaceholder')
    fireEvent.change(search, { target: { value: 'reboot' } })
    const lastCall = useCommandRecords.mock.calls.at(-1)
    expect(lastCall?.[0]).toMatchObject({ q: 'reboot', offset: 0, limit: 50 })
  })

  it('scopes the query to a fixed session and hides the session input', () => {
    render(<CommandRecordsPage sessionId="sess-9" />)
    expect(useCommandRecords.mock.calls.at(-1)?.[0]).toMatchObject({ session_id: 'sess-9' })
    expect(screen.queryByLabelText('commandRecords.fields.sessionId')).toBeNull()
    expect(screen.queryByText('actions.clearFilters')).toBeNull()
  })

  it('renders the timestamp with the full time on hover', () => {
    const { container } = render(<CommandRecordsPage />)
    const time = container.querySelector('tbody time')
    expect(time).toHaveAttribute('dateTime', '2026-07-01T10:00:00Z')
    expect(time).toHaveAttribute('title', formatFullDateTime('2026-07-01T10:00:00Z', 'en'))
  })

  it('omits the page header when embedded', () => {
    render(<CommandRecordsPage embedded />)
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })
})
