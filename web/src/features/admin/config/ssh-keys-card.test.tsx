import type { StoredSSHKey } from '@/shared/lib/api/ssh-keys'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/app/query-client'
import { ApiError } from '@/shared/lib/api/http'
import { Toaster } from '@/shared/ui/sonner'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/ssh-keys', () => ({
  listSshKeys: vi.fn(),
  generateSshKeys: vi.fn(),
  importSshKey: vi.fn(),
}))

const { listSshKeys, generateSshKeys, importSshKey } = await import('@/shared/lib/api/ssh-keys')
const { SshKeysCard } = await import('./ssh-keys-card')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function key(algorithm: string): StoredSSHKey {
  return {
    id: algorithm,
    algorithm,
    public_key_openssh: `${algorithm} AAAA`,
    fingerprint: `SHA256:${algorithm}`,
    created: '2026-11-02T00:00:00Z',
  }
}

function renderCard() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <I18nextProvider i18n={i18n}>
        <SshKeysCard />
      </I18nextProvider>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('sshKeysCard', () => {
  beforeEach(() => {
    vi.mocked(listSshKeys).mockReset()
    vi.mocked(generateSshKeys).mockReset()
    vi.mocked(importSshKey).mockReset()
  })

  it('warns that SSH is off without host keys and generates the missing keys', async () => {
    vi.mocked(listSshKeys)
      .mockResolvedValueOnce([])
      .mockResolvedValue([key('ssh-ed25519'), key('rsa-sha2-512')])
    vi.mocked(generateSshKeys).mockResolvedValue([])
    renderCard()

    expect(await screen.findByText(/SSH does not listen until host keys exist/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate host keys' }))

    await waitFor(() => expect(generateSshKeys).toHaveBeenCalled())
    expect(await screen.findByText('SHA256:ssh-ed25519')).toBeTruthy()
    expect(screen.queryByText(/SSH does not listen until host keys exist/)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generate host keys' }).disabled).toBe(true)
  })

  it('imports a private key and reports a rejected one', async () => {
    vi.mocked(listSshKeys).mockResolvedValue([key('ssh-ed25519')])
    vi.mocked(importSshKey)
      .mockRejectedValueOnce(new ApiError(400, 'invalid private key: bad', 'invalid private key: bad'))
      .mockResolvedValue(key('ssh-ed25519'))
    renderCard()

    await screen.findByText('SHA256:ssh-ed25519')
    fireEvent.click(screen.getByRole('button', { name: 'Import host key' }))
    fireEvent.change(await screen.findByLabelText('Private key'), { target: { value: 'PEM' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('invalid private key: bad')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(importSshKey).toHaveBeenLastCalledWith(
      { private_key_pem: 'PEM', passphrase: null },
    ))
    await waitFor(() => expect(screen.queryByLabelText('Private key')).toBeNull())
  })
})
