import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TicketShareDialog } from './ticket-share-dialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.what ? `${key}:${String(opts.what)}` : key) }),
}))
vi.mock('@/shared/hooks/use-info', () => ({
  useInfo: () => ({ data: { external_host: 'gw.example.com', ports: { ssh: 2222, mysql: 3306, postgres: 5432, http: null, kubernetes: null } } }),
}))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTargets: () => ({ data: [{ id: 't1', name: 'web-01', kind: 'ssh' }, { id: 't2', name: 'site', kind: 'http' }] }),
}))

afterEach(cleanup)

it('shows the link, the SSH command and the secret, each with a copy button', () => {
  const writeText = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  render(<TicketShareDialog secret="s3cret" targetName="web-01" onClose={() => {}} />)
  expect(screen.getByText(`${window.location.origin}/ui/ticket#s3cret`)).toBeTruthy()
  expect(screen.getByText('ssh -p 2222 ticket-s3cret@gw.example.com')).toBeTruthy()
  expect(screen.getByText('s3cret')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'tickets.share.copyLabel:tickets.share.command' }))
  expect(writeText).toHaveBeenCalledWith('ssh -p 2222 ticket-s3cret@gw.example.com')
  expect(screen.getByRole('status')).toHaveTextContent('tickets.share.copied:tickets.share.command')
})

it('offers only the link for an HTTP target', () => {
  render(<TicketShareDialog secret="s3cret" targetName="site" onClose={() => {}} />)
  expect(screen.queryByText('tickets.share.command')).toBeNull()
  expect(screen.getByText(`${window.location.origin}/ui/ticket#s3cret`)).toBeTruthy()
})
