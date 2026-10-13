import type { CommandRecordsResponse } from '@/shared/lib/api/command-records'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
})
