import type { AuditEntry } from '@/shared/types/domain'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/features/audit/hooks/use-audit-queries', () => ({
  useAudit: vi.fn(),
}))

const hooks = await import('@/features/audit/hooks/use-audit-queries')
const useAudit = vi.mocked(hooks.useAudit)

const { AdminAuditPage } = await import('./admin-audit-page')

const SESSION_ID = '3f2b9c1e-8a47-4d2e-9b6f-0c1d2e3f4a5b'

const ENTRIES: AuditEntry[] = [
  {
    id: 'log-1',
    at: new Date().toISOString(),
    actor: 'alice',
    action: 'target_connected',
    values: { target: 'web-1', port: 22 },
    sessionId: SESSION_ID,
    ageDays: 0,
  },
  {
    id: 'log-2',
    at: new Date().toISOString(),
    actor: 'bob',
    action: 'auth_logout',
    values: {},
    sessionId: SESSION_ID,
    ageDays: 0,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  useAudit.mockReturnValue({ data: ENTRIES, isPending: false } as unknown as ReturnType<typeof hooks.useAudit>)
})

describe('adminAuditPage rows', () => {
  it('shows human event labels and the short session id instead of the raw UUID', () => {
    const { container } = render(<AdminAuditPage />)
    expect(screen.getByText('events.targetConnected')).toBeInTheDocument()
    expect(screen.getByText('events.logout')).toBeInTheDocument()
    expect(container.querySelector('tbody')?.textContent).not.toContain(SESSION_ID)
  })

  it('renders the time cell with the full timestamp on hover', () => {
    const { container } = render(<AdminAuditPage />)
    const time = container.querySelector('tbody time')
    expect(time?.getAttribute('dateTime')).toBe(ENTRIES[0]!.at)
    expect(time?.getAttribute('title')).toBeTruthy()
    expect(time?.textContent).not.toBe(ENTRIES[0]!.at)
  })

  it('collapses details by default and toggles them', () => {
    render(<AdminAuditPage />)
    const toggles = screen.getAllByRole('button', { name: 'audit.details.expand' })
    expect(toggles).toHaveLength(1)
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('web-1')).toBeNull()

    fireEvent.click(toggles[0]!)
    const collapse = screen.getByRole('button', { name: 'audit.details.collapse' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('web-1')).toBeInTheDocument()
    expect(screen.getByText('port')).toBeInTheDocument()

    fireEvent.click(collapse)
    expect(screen.queryByText('web-1')).toBeNull()
  })

  it('still matches the raw action text when searching', () => {
    render(<AdminAuditPage />)
    fireEvent.change(screen.getByLabelText('audit.searchAria'), { target: { value: 'auth_logout' } })
    expect(screen.getByText('events.logout')).toBeInTheDocument()
    expect(screen.queryByText('events.targetConnected')).toBeNull()
  })
})

describe('adminAuditPage paging', () => {
  it('loads older entries on demand', () => {
    const fetchNextPage = vi.fn()
    useAudit.mockReturnValue({ data: ENTRIES, isPending: false, hasNextPage: true, fetchNextPage } as unknown as ReturnType<typeof hooks.useAudit>)
    render(<AdminAuditPage />)
    fireEvent.click(screen.getByRole('button', { name: 'pagination.loadMore' }))
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it('hides load more once everything is loaded', () => {
    render(<AdminAuditPage />)
    expect(screen.queryByRole('button', { name: 'pagination.loadMore' })).toBeNull()
  })
})
