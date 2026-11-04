import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TrustHostKeyDialog } from './trust-host-key-dialog'

const api = vi.hoisted(() => ({
  addKnownHost: vi.fn(async () => ({})),
  checkSshHostKey: vi.fn(async () => ({ remote_key_type: 'ssh-ed25519', remote_key_base64: 'AAAAC3Nz', fingerprint: 'SHA256:abc' })),
}))
vi.mock('@/shared/lib/api/known-hosts', () => api)

beforeEach(() => vi.clearAllMocks())

function renderDialog(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TrustHostKeyDialog open host="10.0.0.1" port={2222} onClose={onClose} />
    </QueryClientProvider>,
  )
  return onClose
}

it('fetches the key through the gateway, shows its fingerprint and trusts it', async () => {
  const onClose = renderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'knownHosts.trust.fetch' }))
  expect(await screen.findByText('SHA256:abc')).toBeTruthy()
  expect(api.checkSshHostKey).toHaveBeenCalledWith({ host: '10.0.0.1', port: 2222 })
  expect(screen.getByLabelText('knownHosts.trust.key')).toHaveProperty('value', 'ssh-ed25519 AAAAC3Nz')

  fireEvent.click(screen.getByRole('button', { name: 'knownHosts.trust.submit' }))
  await waitFor(() => expect(api.addKnownHost).toHaveBeenCalledWith({ host: '10.0.0.1', port: 2222, key_type: 'ssh-ed25519', key_base64: 'AAAAC3Nz' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('trusts a pasted ssh-keyscan line', async () => {
  renderDialog()
  fireEvent.change(screen.getByLabelText('knownHosts.trust.key'), { target: { value: '[10.0.0.1]:2222 ssh-rsa AAAAB3Nz' } })
  fireEvent.click(screen.getByRole('button', { name: 'knownHosts.trust.submit' }))
  await waitFor(() => expect(api.addKnownHost).toHaveBeenCalledWith({ host: '10.0.0.1', port: 2222, key_type: 'ssh-rsa', key_base64: 'AAAAB3Nz' }))
})

it('explains a line without a key', () => {
  renderDialog()
  fireEvent.change(screen.getByLabelText('knownHosts.trust.key'), { target: { value: 'nonsense' } })
  fireEvent.click(screen.getByRole('button', { name: 'knownHosts.trust.submit' }))
  expect(screen.getByRole('alert').textContent).toContain('knownHosts.trust.invalidKey')
  expect(api.addKnownHost).not.toHaveBeenCalled()
})
