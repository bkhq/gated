import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { KnownHostDetailsDialog } from './known-host-details-dialog'

vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTargets: () => ({
    data: [
      { id: 't1', name: 'github-proxy', kind: 'ssh', host: 'github.com', port: 22, user: 'git', group: '' },
      { id: 't2', name: 'other', kind: 'ssh', host: 'github.com', port: 2222, user: 'git', group: '' },
    ],
  }),
}))

it('shows the full key, its fingerprint and the targets using the endpoint', async () => {
  render(
    <KnownHostDetailsDialog
      host={{ id: 'k1', host: 'github.com', hostname: 'github.com', port: 22, algo: 'ssh-ed25519', fingerprint: 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' }}
      onClose={() => {}}
    />,
  )
  expect(await screen.findByText('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU')).toBeTruthy()
  expect(screen.getByText('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl')).toBeTruthy()
  expect(screen.getByText('github-proxy')).toBeTruthy()
  expect(screen.queryByText('other')).toBeNull()
})
