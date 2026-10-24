import type { Recording } from '@/shared/lib/api/recordings'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TrafficPlayer } from './traffic-player'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'capture-2026-05-15',
    started: '2026-05-15T10:00:00Z',
    ended: '2026-05-15T10:05:00Z',
    session_id: '99999999-2222-3333-4444-555555555555',
    kind: 'Traffic',
    metadata: '{"interface":"eth0","filter":"tcp"}',
    ...overrides,
  }
}

describe('trafficPlayer', () => {
  it('renders a streaming download link to the tcpdump endpoint', () => {
    render(<TrafficPlayer recording={makeRecording()} />)
    const link = screen.getByRole('link', { name: /recordings\.traffic\.download/ })
    expect(link).toHaveAttribute('href', '/admin/api/recordings/11111111-2222-3333-4444-555555555555/tcpdump')
    expect(link).toHaveAttribute('download', 'capture-2026-05-15.pcap')
  })

  it('encodes the recording id in the download URL', () => {
    render(<TrafficPlayer recording={makeRecording({ id: 'id/with spaces' })} />)
    const link = screen.getByRole('link', { name: /recordings\.traffic\.download/ })
    expect(link).toHaveAttribute('href', '/admin/api/recordings/id%2Fwith%20spaces/tcpdump')
  })

  it('shows the recording name and metadata', () => {
    render(<TrafficPlayer recording={makeRecording()} />)
    expect(screen.getByText('capture-2026-05-15')).toBeInTheDocument()
    expect(screen.getByText('{"interface":"eth0","filter":"tcp"}')).toBeInTheDocument()
  })

  it('falls back to a placeholder when ended is missing', () => {
    render(<TrafficPlayer recording={makeRecording({ ended: undefined })} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders the wrongKind empty state when kind is not Traffic', () => {
    render(<TrafficPlayer recording={makeRecording({ kind: 'Terminal' })} />)
    expect(screen.getByText('recordings.traffic.wrongKind')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
