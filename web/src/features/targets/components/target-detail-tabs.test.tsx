import type { Target } from '@/shared/types/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TargetDetailTabsBody } from './target-detail-tabs'
import { useTargetDetailTabs } from './use-target-detail-tabs'

vi.mock('@/shared/hooks/use-info', () => ({ useInfo: () => ({ data: undefined }) }))
vi.mock('@/features/api-tokens/hooks/use-api-tokens-queries', () => ({ useCreateApiToken: () => ({ isPending: false, mutateAsync: vi.fn() }) }))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({ useTargetRoles: () => ({ data: [] }) }))
vi.mock('@/shared/lib/api/targets', () => ({
  getTargetKnownSshHostKeys: vi.fn(async () => []),
  getTargetUpstreamCertificate: vi.fn(async () => ({
    tls: true,
    verify: true,
    chain: [{
      subject: 'CN=grafana.internal',
      issuer: 'CN=Internal CA',
      serial: '01',
      not_before: '2026-01-01T00:00:00+00:00',
      not_after: '2027-01-01T00:00:00+00:00',
      subject_alt_names: ['grafana.internal'],
      sha256_fingerprint: 'AB:CD',
    }],
    verify_error: 'invalid peer certificate: UnknownIssuer',
    error: null,
  })),
}))

afterEach(cleanup)

const sshTarget: Target = { id: 't-1', name: 'prod-api', kind: 'ssh', host: '10.0.0.1', port: 22, user: 'deploy', group: '' }

function renderOverview(target: Target) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TargetDetailTabsBody target={target} mode="user" mySessions={[]} tabsValue="overview" onTabsChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

it('renders the real target description with line breaks preserved', () => {
  renderOverview({ ...sshTarget, description: 'Line one\nLine two' })
  const description = screen.getByText((_, node) => node?.textContent === 'Line one\nLine two' && node.children.length === 0)
  expect(description).toHaveClass('whitespace-pre-line')
  expect(document.body).not.toHaveTextContent('Acme')
  expect(document.body).not.toHaveTextContent(/overview\.notes[GD]/)
  expect(screen.queryByText('targets.detail.overview.notesEmpty')).not.toBeInTheDocument()
})

it('renders an empty state when the description is blank', () => {
  renderOverview({ ...sshTarget, description: '   ' })
  expect(screen.getByText('targets.detail.overview.notesEmpty')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent(/overview\.notes[GD]/)
})

it('shows the read-only policy line for DB targets', () => {
  renderOverview({ ...sshTarget, kind: 'mysql', port: 3306, readonly: true })
  expect(screen.getByText('targets.detail.overview.readOnly')).toBeInTheDocument()
  expect(screen.getByText('targets.detail.overview.policySummary')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent(/overview\.notes[GD]/)
})

it('hides the read-only policy line and empty policy card for non-DB targets', () => {
  renderOverview(sshTarget)
  expect(screen.queryByText('targets.detail.overview.readOnly')).not.toBeInTheDocument()
  expect(screen.queryByText('targets.detail.overview.policySummary')).not.toBeInTheDocument()
})

it('localizes the Port label', () => {
  renderOverview(sshTarget)
  expect(screen.getByText('targets.detail.overview.port')).toBeInTheDocument()
  expect(screen.queryByText('Port')).not.toBeInTheDocument()
})

function renderSecurity(target: Target) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TargetDetailTabsBody target={target} mode="admin" mySessions={[]} tabsValue="security" onTabsChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

it('shows the upstream certificate chain for HTTP targets', async () => {
  renderSecurity({ ...sshTarget, kind: 'http', host: 'https://grafana.internal', port: 0, tls: { mode: 'Preferred', verify: true } })
  expect(await screen.findByText('CN=grafana.internal')).toBeInTheDocument()
  expect(screen.getByText('CN=Internal CA')).toBeInTheDocument()
  expect(screen.getByText('AB:CD')).toBeInTheDocument()
  expect(screen.getByText('invalid peer certificate: UnknownIssuer')).toBeInTheDocument()
  expect(screen.queryByText('targets.detail.security.title')).not.toBeInTheDocument()
})

it('shows the TLS settings for database targets', () => {
  renderSecurity({ ...sshTarget, kind: 'postgres', port: 5432, tls: { mode: 'Required', verify: false } })
  expect(screen.getByText('targets.detail.security.tlsModes.Required')).toBeInTheDocument()
  expect(screen.getByText('targets.detail.security.verifyOff')).toBeInTheDocument()
  expect(screen.queryByText('targets.detail.security.title')).not.toBeInTheDocument()
})

it('offers the security tab to users only for SSH targets', () => {
  const tabs = (kind: Target['kind'], mode: 'user' | 'admin') => {
    const { result } = renderHook(() => useTargetDetailTabs(0, { ...sshTarget, kind }, mode))
    const view = render(<>{result.current.list}</>)
    const found = view.queryByText('targets.detail.tabs.security') !== null
    view.unmount()
    return found
  }
  expect(tabs('ssh', 'user')).toBe(true)
  expect(tabs('http', 'user')).toBe(false)
  expect(tabs('mysql', 'user')).toBe(false)
  expect(tabs('http', 'admin')).toBe(true)
  expect(tabs('postgres', 'admin')).toBe(true)
})
