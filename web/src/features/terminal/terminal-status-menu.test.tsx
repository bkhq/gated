import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalStatusMenu } from './terminal-status-menu'

describe('terminalStatusMenu', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a long error out of the status bar and shows it on demand', async () => {
    const message = `SSH connection failed: ${'x'.repeat(300)}`
    render(
      <TerminalStatusMenu
        status="error"
        message={message}
        connection={null}
        kind="ssh"
        targetName="web-01"
      />,
    )
    expect(screen.queryByText(message)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Session error/ }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByText('SSH · web-01')).toBeInTheDocument()
  })

  it('shows the server facts of an established connection', async () => {
    render(
      <TerminalStatusMenu
        status="connected"
        message="SSH session established"
        connection={{
          connectedAt: new Date('2026-10-23T10:00:00Z'),
          endedAt: null,
          details: {
            session_id: 'b7d4e9a1',
            address: '10.0.0.5:22',
            username: 'root',
            host_key: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' },
          },
        }}
        kind="ssh"
        targetName="web-01"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Connected/ }))
    expect(await screen.findByText('10.0.0.5:22')).toBeInTheDocument()
    expect(screen.getByText('root')).toBeInTheDocument()
    expect(screen.getByText('b7d4e9a1')).toBeInTheDocument()
    expect(screen.getByText('ssh-ed25519 SHA256:abc')).toBeInTheDocument()
  })

  it('describes the database TLS settings', async () => {
    render(
      <TerminalStatusMenu
        status="connected"
        message="PostgreSQL client started"
        connection={{
          connectedAt: new Date('2026-10-23T10:00:00Z'),
          endedAt: new Date('2026-10-23T10:01:05Z'),
          details: {
            session_id: 's',
            address: 'db:5432',
            username: 'app',
            tls: { mode: 'required', verify: false },
            client: 'psql',
            database: 'orders',
          },
        }}
        kind="postgres"
        targetName="pg-01"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Connected/ }))
    expect(await screen.findByText('required · certificate not verified')).toBeInTheDocument()
    expect(screen.getByText('psql')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(screen.getByText('1m 5s')).toBeInTheDocument()
  })

  it('shows the live duration as of opening the popover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
    render(
      <TerminalStatusMenu
        status="connected"
        connection={{ connectedAt: new Date('2026-10-23T10:00:00Z'), endedAt: null }}
        kind="ssh"
        targetName="web-01"
      />,
    )
    vi.setSystemTime(new Date('2026-10-23T10:02:03Z'))
    fireEvent.click(screen.getByRole('button', { name: /Connected/ }))
    await screen.findByText('Connection')
    expect(screen.getByText('2m 3s')).toBeInTheDocument()
  })
})
