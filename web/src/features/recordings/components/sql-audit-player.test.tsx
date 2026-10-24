import type { Recording } from '@/shared/lib/api/recordings'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SqlAuditPlayer } from './sql-audit-player'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string, children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}))

const fixture: Recording = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'mysql-prod-2026-05-31',
  started: '2026-05-31T12:00:00Z',
  ended: '2026-05-31T12:34:56Z',
  session_id: '00000000-0000-0000-0000-000000000002',
  kind: 'SqlAudit',
  metadata: '{"db":"orders","statements":42}',
}

describe('sqlAuditPlayer', () => {
  it('renders the recording name and metadata, plus an audit-log link', () => {
    render(<SqlAuditPlayer recording={fixture} />)

    expect(screen.getByText(fixture.name)).toBeInTheDocument()
    expect(screen.getByText(fixture.metadata)).toBeInTheDocument()

    const link = screen.getByRole('link', { name: 'recordings.sqlAudit.openAudit' })
    expect(link).toHaveAttribute('href', '/admin/audit')
  })

  it('falls back to an em dash when ended is missing', () => {
    const { ended, ...rest } = fixture
    void ended
    render(<SqlAuditPlayer recording={rest} />)

    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
